#!/usr/bin/env bash
#
# build-disk-guard.sh - pre-flight checks for firmware builds on shared hosts
#
# Two independent guards, run before kicking off any CAMERA=... make/docker
# build on a host that also runs other workloads (e.g. macmini-devserver,
# which also serves CI deploys):
#
#   1. disk:   refuse/defer if free space on the data volume is below a
#              floor (default 40 GiB). Firmware builds are disk-write-heavy
#              (per-package build trees, ccache, download cache) and have
#              been observed driving a shared host below the CI disk guard
#              floor (30 GiB), blocking unrelated deploys.
#   2. faabzi: refuse/defer while a "Deploy faabzi" GitHub Actions run is
#              in_progress on this host's fleet, so a multi-minute,
#              CPU/disk-heavy firmware build never contends with it.
#
# Usage:
#   scripts/build-disk-guard.sh                 # run both checks
#   scripts/build-disk-guard.sh disk            # disk check only
#   scripts/build-disk-guard.sh faabzi          # faabzi-deploy check only
#
# Exit status: 0 = clear to build, 1 = refuse (blocking condition found),
# 2 = a check could not be completed (treated as a soft warning, not a
# refusal - see NOTES below).
#
# Env overrides:
#   DISK_FLOOR_GB      minimum free GiB required (default: 40)
#   DISK_CHECK_PATH    path/volume to check (default: /System/Volumes/Data
#                       on macOS, else the repo's filesystem)
#   FAABZI_REPO        GitHub repo slug to query (default: raajkumars/qwickapps)
#   FAABZI_WORKFLOW    workflow display name to match (default: "Deploy faabzi")
#   SKIP_DISK_CHECK=1  skip the disk guard (emergency override, logged)
#   SKIP_FAABZI_CHECK=1 skip the faabzi guard (emergency override, logged)
#
# NOTES:
#   - The disk check is a hard gate: if we can measure free space and it is
#     below the floor, we refuse. If we cannot measure it at all (df
#     missing/unparseable), we refuse too - "unknown" is treated as "low"
#     for a resource that bricks concurrent deploys when exhausted.
#   - The faabzi check is a soft gate: it needs `gh` auth + network access
#     to a private org repo. If `gh` is missing, unauthenticated, or the
#     query errors out, we warn and allow the build to proceed - a flaky
#     check must not permanently wedge the build pipeline. It only refuses
#     when it POSITIVELY confirms an in_progress "Deploy faabzi" run.
#   - This script never deletes anything. See clean-build-intermediates.sh
#     for the post-build cleanup half of the build-hygiene contract.

set -u

DISK_FLOOR_GB="${DISK_FLOOR_GB:-40}"
FAABZI_REPO="${FAABZI_REPO:-raajkumars/qwickapps}"
FAABZI_WORKFLOW="${FAABZI_WORKFLOW:-Deploy faabzi}"

log() { printf '[build-disk-guard] %s\n' "$*" >&2; }

default_disk_check_path() {
	if [ -d "/System/Volumes/Data" ]; then
		printf '%s\n' "/System/Volumes/Data"
	else
		printf '%s\n' "."
	fi
}

check_disk() {
	if [ "${SKIP_DISK_CHECK:-0}" = "1" ]; then
		log "SKIPPED (SKIP_DISK_CHECK=1) - disk floor not verified"
		return 0
	fi

	local path="${DISK_CHECK_PATH:-$(default_disk_check_path)}"
	local avail_gb=""

	if command -v df >/dev/null 2>&1; then
		# macOS: `df -g` reports whole GiB directly (BSD df).
		if df -g "$path" >/dev/null 2>&1; then
			avail_gb=$(df -g "$path" 2>/dev/null | awk 'NR==2 {print $4}')
		else
			# Linux/GNU df: force 1G blocks, strip the trailing "G".
			avail_gb=$(df -BG --output=avail "$path" 2>/dev/null | awk 'NR==2 {gsub("G","");print}')
		fi
	fi

	if ! [[ "$avail_gb" =~ ^[0-9]+$ ]]; then
		log "REFUSE: could not determine free space on '$path' (df gave '$avail_gb')"
		log "        Treating unknown free space as below the floor - fix df/path and retry."
		return 1
	fi

	if [ "$avail_gb" -lt "$DISK_FLOOR_GB" ]; then
		log "REFUSE: only ${avail_gb} GiB free on '$path' (floor: ${DISK_FLOOR_GB} GiB)."
		log "        Free space first (see scripts/clean-build-intermediates.sh) or defer this build."
		return 1
	fi

	log "OK: ${avail_gb} GiB free on '$path' (floor: ${DISK_FLOOR_GB} GiB)."
	return 0
}

check_faabzi() {
	if [ "${SKIP_FAABZI_CHECK:-0}" = "1" ]; then
		log "SKIPPED (SKIP_FAABZI_CHECK=1) - faabzi deploy status not verified"
		return 0
	fi

	if ! command -v gh >/dev/null 2>&1; then
		log "WARN: gh CLI not found - cannot verify '$FAABZI_WORKFLOW' status, proceeding anyway."
		return 0
	fi

	local runs
	if ! runs=$(gh run list -R "$FAABZI_REPO" --workflow "$FAABZI_WORKFLOW" -L 3 \
		--json status,conclusion,displayTitle,createdAt 2>/dev/null); then
		log "WARN: 'gh run list' failed (auth/network?) - cannot verify '$FAABZI_WORKFLOW' status, proceeding anyway."
		return 0
	fi

	if [ -z "$runs" ] || [ "$runs" = "[]" ]; then
		log "OK: no recent '$FAABZI_WORKFLOW' runs found on $FAABZI_REPO."
		return 0
	fi

	local in_progress
	in_progress=$(printf '%s' "$runs" | python3 -I -c '
import json, sys
runs = json.load(sys.stdin)
hits = [r for r in runs if r.get("status") == "in_progress"]
print(len(hits))
' 2>/dev/null)

	if [ "${in_progress:-0}" != "0" ] 2>/dev/null; then
		log "REFUSE: '$FAABZI_WORKFLOW' is in_progress on $FAABZI_REPO - a firmware build would"
		log "        contend for disk/CPU with a live deploy. Wait for it to finish and retry."
		log "        Check: gh run list -R $FAABZI_REPO --workflow \"$FAABZI_WORKFLOW\" -L 3"
		return 1
	fi

	log "OK: no in_progress '$FAABZI_WORKFLOW' run on $FAABZI_REPO."
	return 0
}

main() {
	local mode="${1:-all}"
	local status=0

	case "$mode" in
	disk)
		check_disk || status=1
		;;
	faabzi)
		check_faabzi || status=1
		;;
	all)
		check_disk || status=1
		check_faabzi || status=1
		;;
	*)
		log "Usage: $0 [disk|faabzi|all]"
		exit 2
		;;
	esac

	if [ "$status" -ne 0 ]; then
		log "Build refused - see REFUSE lines above."
	else
		log "Clear to build."
	fi
	exit "$status"
}

main "$@"
