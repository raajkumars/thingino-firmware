# Build hygiene on shared hosts

Firmware builds are disk-write-heavy: per-package build trees, `.buildroot-ccache`,
and the download cache can push a checkout well past 2-9 GiB, and a checkout
left on the wrong branch's output tree (e.g. after switching HEAD) never gets
reclaimed on its own. On a host that also runs other workloads (CI deploys,
other agents' builds), this has driven free space low enough to trip
unrelated disk guards.

Two scripts under `scripts/` cover the pre-flight and post-build halves of
this. Neither is wired into the default `make all`/`fast`/`dev` targets -
normal incremental development keeps its existing behavior. They are meant to
be run explicitly around one-shot/CI-style builds (the kind that build once,
copy the image to `build-artifacts/`, and never need the output tree again).

## Before building: `scripts/build-disk-guard.sh`

```sh
scripts/build-disk-guard.sh            # both checks
scripts/build-disk-guard.sh disk       # disk floor only
scripts/build-disk-guard.sh faabzi     # faabzi-deploy-in-progress only
```

- **disk**: refuses (exit 1) if free space on the data volume is below
  `DISK_FLOOR_GB` (default 40 GiB). An unmeasurable free-space value is
  treated as below the floor, not as "fine" - this is a hard gate.
- **faabzi**: refuses if a `Deploy faabzi` GitHub Actions run is
  `in_progress` on `FAABZI_REPO` (default `raajkumars/qwickapps`), so a
  multi-minute build never contends with a live deploy for disk/CPU. This is
  a soft gate: if `gh` is missing, unauthenticated, or the query errors, it
  warns and lets the build proceed rather than wedging the pipeline on an
  infra hiccup. It only refuses on a *positive* `in_progress` match.
- Both checks are check-then-act, not a lock: another build or deploy can
  start immediately after this script says "clear to build" and before the
  real build starts writing. It reduces contention risk; it does not
  eliminate it. Re-run short-lived builds close to when they actually start.
- Escape hatches `SKIP_DISK_CHECK=1` / `SKIP_FAABZI_CHECK=1` exist for a
  deliberate, logged override - they do not silently disable anything.

## After building: `scripts/clean-build-intermediates.sh`

```sh
# Dry run (default) - lists what would go, nothing deleted:
scripts/clean-build-intermediates.sh

# Keep only the current camera's tree on the current branch, remove the
# rest (other profiles on this branch, and any stale branch trees left
# over from a previous HEAD in this same checkout):
scripts/clean-build-intermediates.sh --keep-camera wyze_cam3_t31x_gc2053_rtl8189ftv --yes

# Refuse to delete the current branch+camera tree unless the image has
# already been copied to build-artifacts/:
scripts/clean-build-intermediates.sh --keep-camera CAM \
  --require-artifact 'thingino-CAM*.bin' --yes
```

What it does and does not touch:

- Operates only on `output/` (Buildroot's `OUTPUT_DIR` tree, identified by
  the `.config` file every build tree carries). Never touches `dl/`
  (download cache - shared, slow to regenerate, explicitly kept),
  `.buildroot-ccache`, `build-artifacts/`, or anything above `output/`.
- Every deletion target is re-resolved to its real path and must be a
  strict descendant of `<repo-root>/output` immediately before deletion.
  If that check ever fails, the whole run aborts with nothing deleted - the
  script treats that as its own bug, not something to route around. Escalate
  with a scoped Prime-approval card before changing what it's allowed to
  touch; don't `rm -rf` by hand instead.
- Dry-run by default; `--yes` is required to actually delete.

## Fleet usage pattern

For the "build once in a container, copy the image out" workflow agents use
(see the `qwickwatch-edge-platform` skill):

1. `scripts/build-disk-guard.sh` - refuse/defer if either check fails.
2. Run the build (container or host `make CAMERA=... fast`).
3. Copy the finished image to `build-artifacts/<camera>/`.
4. `scripts/clean-build-intermediates.sh --keep-camera <camera> --require-artifact '<pattern>' --yes`
   to reclaim the just-built tree plus any stale/wrong-profile trees.
