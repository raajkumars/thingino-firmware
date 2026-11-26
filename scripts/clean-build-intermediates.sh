#!/usr/bin/env bash
#
# clean-build-intermediates.sh - prune disposable output/ build trees
#
# Buildroot's OUTPUT_DIR is output/<branch>/<camera>-<kernel>-<libc>[-<ip>]/
# (see Makefile's OUTPUT_DIR / OUTPUT_BASE_DIR). Every such leaf directory
# (identified by the .config file Buildroot always writes into it) is a
# fully disposable, regenerable build tree - everything that matters either
# ships in build-artifacts/ (the firmware image) or lives outside output/
# (dl/ downloads, .buildroot-ccache). This script removes:
#
#   (b) leaf dirs belonging to a stale branch (not the current HEAD) -
#       leftovers from a prior checkout of this same working tree.
#   (d) leaf dirs under the CURRENT branch whose camera does not match
#       --keep-camera (e.g. an old atom_cam2 tree once the profile moves
#       to wyze_cam3) - "wrong profile trees".
#
# Safety:
#   - Every deletion target is re-resolved with `pwd -P` and MUST be a
#     strict descendant of <repo-root>/output. Anything else aborts the
#     WHOLE run before deleting anything, with no exceptions - this script
#     never touches dl/, .git, .buildroot-ccache, build-artifacts/, or
#     anything above output/. If that ever trips, it means the leaf
#     detection logic is wrong - fix the script, do not delete by hand.
#   - Dry-run by default. Pass --yes to actually delete.
#   - With --require-artifact <glob>, refuses to remove the CURRENT
#     branch+camera leaf unless a file matching the glob already exists
#     under build-artifacts/ (i.e. the image was copied out first).
#
# Usage:
#   scripts/clean-build-intermediates.sh [--yes]
#   scripts/clean-build-intermediates.sh --keep-camera wyze_cam3_t31x_gc2053_rtl8189ftv [--yes]
#   scripts/clean-build-intermediates.sh --keep-camera CAM --require-artifact 'thingino-CAM*.bin' --yes
#
# Exit status: 0 = ok (including a no-op dry run), 1 = refused (safety
# check failed or nothing to do that looked wrong), 2 = usage error.

set -u

KEEP_CAMERAS=()
REQUIRE_ARTIFACT=""
DO_DELETE=0

while [ $# -gt 0 ]; do
	case "$1" in
	--keep-camera)
		KEEP_CAMERAS+=("$2")
		shift 2
		;;
	--require-artifact)
		REQUIRE_ARTIFACT="$2"
		shift 2
		;;
	--yes)
		DO_DELETE=1
		shift
		;;
	-h | --help)
		sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
		exit 0
		;;
	*)
		echo "Unknown argument: $1" >&2
		exit 2
		;;
	esac
done

log() { printf '[clean-build-intermediates] %s\n' "$*" >&2; }
die() {
	log "ABORT: $*"
	log "       No deletions performed. If you believe this script's own safety"
	log "       check is wrong, escalate with a scoped Prime-approval card before"
	log "       widening what it's allowed to touch."
	exit 1
}

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not inside a git repository"
OUTPUT_ROOT="$REPO_ROOT/output"
BUILD_ARTIFACTS="$REPO_ROOT/build-artifacts"
CURRENT_BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null)" || die "could not resolve current branch"

[ -d "$OUTPUT_ROOT" ] || {
	log "No output/ directory at $OUTPUT_ROOT - nothing to clean."
	exit 0
}

OUTPUT_ROOT_REAL="$(cd "$OUTPUT_ROOT" && pwd -P)"

is_contained() {
	# $1 must be a strict descendant of OUTPUT_ROOT_REAL
	local target_real="$1"
	case "$target_real" in
	"$OUTPUT_ROOT_REAL"/*) return 0 ;;
	*) return 1 ;;
	esac
}

camera_matches_keep() {
	local camera_dir_name="$1"
	# bash 3.2 (macOS system bash) errors on "${arr[@]}" under set -u when
	# the array has never been assigned an element; guard with ${arr[@]-}.
	[ "${#KEEP_CAMERAS[@]-0}" -eq 0 ] && return 0 # no filter => keep all cameras on this branch
	local keep
	for keep in "${KEEP_CAMERAS[@]-}"; do
		case "$camera_dir_name" in
		"$keep"-* | "$keep") return 0 ;;
		esac
	done
	return 1
}

# Collect leaf OUTPUT_DIRs: any directory under output/ containing .config.
# NUL-delimited read loop instead of `mapfile` - this must run under bash
# 3.2 (macOS system bash), which has no mapfile builtin.
leaves=()
while IFS= read -r -d '' cfg; do
	leaves+=("$cfg")
done < <(find "$OUTPUT_ROOT" -mindepth 1 -maxdepth 6 -type f -name '.config' -print0 2>/dev/null)

if [ "${#leaves[@]-0}" -eq 0 ]; then
	log "No Buildroot output trees (.config files) found under $OUTPUT_ROOT - nothing to clean."
	exit 0
fi

to_remove=()
total_kept=0
total_candidates=0

for cfg in "${leaves[@]-}"; do
	leaf_dir="$(dirname "$cfg")"
	leaf_real="$(cd "$leaf_dir" && pwd -P)"

	is_contained "$leaf_real" || die "leaf '$leaf_real' resolved OUTSIDE output/ - refusing to proceed"

	rel="${leaf_real#"$OUTPUT_ROOT_REAL"/}"
	camera_dir_name="$(basename "$rel")"
	branch_rel="$(dirname "$rel")"
	[ "$branch_rel" = "." ] && branch_rel=""

	total_candidates=$((total_candidates + 1))

	if [ "$branch_rel" != "$CURRENT_BRANCH" ]; then
		to_remove+=("$leaf_real")
		continue
	fi

	if camera_matches_keep "$camera_dir_name"; then
		total_kept=$((total_kept + 1))
	else
		to_remove+=("$leaf_real")
	fi
done

log "Current branch: $CURRENT_BRANCH"
log "Candidates scanned: $total_candidates, kept (current branch + matching profile): $total_kept, to remove: ${#to_remove[@]-0}"

if [ "${#to_remove[@]-0}" -eq 0 ]; then
	log "Nothing to remove."
	exit 0
fi

if [ -n "$REQUIRE_ARTIFACT" ]; then
	# Only gate removal of the CURRENT branch's leaf(s); stale-branch leaves
	# from a different checkout never had an artifact-copy obligation here.
	for leaf in "${to_remove[@]-}"; do
		rel="${leaf#"$OUTPUT_ROOT_REAL"/}"
		branch_rel="$(dirname "$rel")"
		[ "$branch_rel" = "." ] && branch_rel=""
		if [ "$branch_rel" = "$CURRENT_BRANCH" ]; then
			# shellcheck disable=SC2086 # intentional glob expansion
			if ! compgen -G "$BUILD_ARTIFACTS/$REQUIRE_ARTIFACT" >/dev/null 2>&1; then
				die "no artifact matching '$REQUIRE_ARTIFACT' under $BUILD_ARTIFACTS - copy the image out before cleaning $leaf"
			fi
		fi
	done
fi

for leaf in "${to_remove[@]-}"; do
	is_contained "$leaf" || die "re-check failed for '$leaf' immediately before deletion"
	size="$(du -sh "$leaf" 2>/dev/null | cut -f1)"
	rel="${leaf#"$OUTPUT_ROOT_REAL"/}"
	if [ "$DO_DELETE" -eq 1 ]; then
		rm -rf -- "$leaf"
		log "REMOVED ${size:-?} output/$rel"
	else
		log "DRY-RUN would remove ${size:-?} output/$rel (pass --yes to delete)"
	fi
done

if [ "$DO_DELETE" -eq 1 ]; then
	find "$OUTPUT_ROOT" -mindepth 1 -type d -empty -delete 2>/dev/null
	log "Done. Re-run 'du -sh $OUTPUT_ROOT' to confirm space freed."
else
	log "Dry run complete - no changes made. Re-run with --yes to apply."
fi
