#!/usr/bin/env python3
"""Resume verified Changwon tile batches without detached processes."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_changwon_road_tiles as tile_builder


ROOT = Path(__file__).resolve().parent
CITY_DIR = ROOT / "data" / "generated" / "changwon-city"
DEFAULT_STATE_DIR = CITY_DIR / "automation"
DEFAULT_BOUNDARY_CACHE = tile_builder.DEFAULT_BOUNDARY_CACHE
DEFAULT_MANIFEST = tile_builder.DEFAULT_MANIFEST
DEFAULT_TILE_DIR = tile_builder.DEFAULT_OUTPUT
DEFAULT_INPUT = tile_builder.DEFAULT_INPUT
PLANNER = ROOT / "plan_changwon_tiles.py"
BUILDER = ROOT / "build_changwon_road_tiles.py"


class RunLock:
    def __init__(self, path: Path):
        self.path = path
        self.handle = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = self.path.open("a+", encoding="utf-8")
        try:
            if os.name == "nt":
                import msvcrt

                self.handle.seek(0, os.SEEK_END)
                if self.handle.tell() == 0:
                    self.handle.write("0")
                    self.handle.flush()
                self.handle.seek(0)
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(self.handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError) as error:
            self.handle.close()
            self.handle = None
            raise RuntimeError(
                f"다른 창원 타일 작업이 실행 중입니다: {self.path}"
            ) from error
        self.handle.seek(0)
        self.handle.truncate()
        self.handle.write(json.dumps({"pid": os.getpid(), "startedAt": utc_now()}))
        self.handle.flush()
        return self

    def __exit__(self, *_: Any) -> None:
        if self.handle is None:
            return
        if os.name == "nt":
            import msvcrt

            self.handle.seek(0)
            msvcrt.locking(self.handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(self.handle.fileno(), fcntl.LOCK_UN)
        self.handle.close()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_state(path: Path, state: dict[str, Any]) -> None:
    state["updatedAt"] = utc_now()
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.part")
    with temporary.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(
            state, output, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)


def new_state() -> dict[str, Any]:
    return {
        "schema": "changwon-tile-runner-v1",
        "startedAt": utc_now(),
        "updatedAt": utc_now(),
        "status": "ready",
        "totalTiles": None,
        "completedTiles": None,
        "remainingTiles": None,
        "tileAttempts": {},
        "failedTiles": {},
        "tileResults": {},
        "batches": [],
        "inFlight": None,
        "lastPosition": None,
    }


def read_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return new_state()
    state = json.loads(path.read_text(encoding="utf-8"))
    if state.get("schema") != "changwon-tile-runner-v1":
        raise ValueError(f"진행 기록 스키마가 올바르지 않습니다: {path}")
    state.setdefault("tileAttempts", {})
    state.setdefault("failedTiles", {})
    state.setdefault("tileResults", {})
    state.setdefault("batches", [])
    state.setdefault("inFlight", None)
    return state


def reconcile_interrupted_state(
    state: dict[str, Any], args: argparse.Namespace, log: Any, state_path: Path
) -> None:
    if state.get("status") != "running":
        return
    active = state.get("inFlight")
    legacy_active = False
    if active is None and isinstance(state.get("lastPosition"), dict):
        active = state["lastPosition"]
        legacy_active = True
    if isinstance(active, dict) and active.get("tileId") and active.get("bbox"):
        tile_id = active["tileId"]
        bbox = tuple(float(value) for value in active["bbox"])
        data_path, marker_path = tile_builder.tile_paths(args.output_dir, bbox)
        marker = tile_builder.validate_complete(data_path, marker_path, bbox)
        if marker is not None:
            state["tileResults"][tile_id] = {
                "status": "complete",
                "sha256": marker["sha256"],
                "completedAt": marker["generatedAt"],
            }
            state["failedTiles"].pop(tile_id, None)
            log(f"[RECOVERED] 중단 전 완료 표식 검증 성공: {tile_id}")
        else:
            if legacy_active:
                current = state["tileAttempts"].get(tile_id, 0)
                if current >= int(active.get("attempt", 1)):
                    state["tileAttempts"][tile_id] = max(0, current - 1)
            log(
                f"[RESUME] 중단된 타일 {tile_id}에 완료 표식이 없습니다. "
                "이전 실행 중단은 실패 재시도 횟수로 계산하지 않습니다."
            )
    state["inFlight"] = None
    for batch in reversed(state.get("batches", [])):
        if batch.get("status") == "running":
            batch["status"] = "interrupted"
            batch["finishedAt"] = utc_now()
            break
    state["status"] = "interrupted"
    write_state(state_path, state)


def make_plan(
    args: argparse.Namespace, plans_dir: Path, log: Any
) -> tuple[Path, dict[str, Any]]:
    plan_path = plans_dir / f"remaining-{time.time_ns()}.json"
    command = [
        sys.executable,
        str(PLANNER),
        "--batch-size",
        str(args.batch_size),
        "--boundary-cache",
        str(args.boundary_cache),
        "--manifest",
        str(args.manifest),
        "--tile-dir",
        str(args.output_dir),
        "--write-list",
        str(plan_path),
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        log("[PLANNER_ERROR] " + (result.stderr.strip() or result.stdout.strip()))
        raise RuntimeError("planner가 최신 잔여 목록을 만들지 못했습니다.")
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    log(
        f"계획 갱신: 전체 {plan['totalTiles']} · 완료 {plan['completedTiles']} · "
        f"남음 {plan['remainingTiles']} · plan={plan_path}"
    )
    return plan_path, plan


def create_single_tile_plan(
    source_plan: dict[str, Any], bbox: list[float], path: Path
) -> Path:
    single = dict(source_plan)
    single["remainingTiles"] = 1
    single["remainingTileBBoxes"] = [bbox]
    single["batchSize"] = 1
    with path.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(
            single, output, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    return path


def execute_tile(
    args: argparse.Namespace,
    source_plan: dict[str, Any],
    plan_path: Path,
    bbox: list[float],
    tile_id: str,
    state: dict[str, Any],
    state_path: Path,
    log: Any,
) -> bool:
    attempts = state["tileAttempts"].get(tile_id, 0)
    if attempts >= 2:
        state["failedTiles"][tile_id] = {
            "attempts": attempts,
            "reason": "retry limit reached",
        }
        write_state(state_path, state)
        log(f"[FAILED] {tile_id}: 이미 허용된 2회 시도를 모두 사용했습니다.")
        return False

    tile_data, tile_marker = tile_builder.tile_paths(args.output_dir, tuple(bbox))
    for attempt in range(attempts + 1, 3):
        state["lastPosition"] = {"tileId": tile_id, "bbox": bbox, "attempt": attempt}
        state["inFlight"] = {
            "tileId": tile_id,
            "bbox": bbox,
            "attempt": attempt,
            "startedAt": utc_now(),
        }
        state["status"] = "running"
        write_state(state_path, state)
        single_plan_path = plan_path.with_name(
            f"{plan_path.stem}-{tile_id}-attempt{attempt}.json"
        )
        create_single_tile_plan(source_plan, bbox, single_plan_path)
        command = [
            sys.executable,
            str(BUILDER),
            "--input",
            str(args.input),
            "--tile-list",
            str(single_plan_path),
            "--limit",
            "1",
            "--output-dir",
            str(args.output_dir),
            "--boundary-cache",
            str(args.boundary_cache),
            "--manifest",
            str(args.manifest),
        ]
        if args.debug:
            command.append("--debug")
        log(f"[TILE_START] {tile_id} attempt={attempt}/2 bbox={bbox}")
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=args.tile_timeout_seconds,
            )
            output = result.stdout or ""
            error_output = result.stderr or ""
            for line in output.splitlines():
                log(f"  {line}")
            if error_output.strip():
                for line in error_output.splitlines():
                    log(f"  STDERR {line}")
            return_code = result.returncode
        except subprocess.TimeoutExpired as error:
            return_code = -1
            partial = error.stdout or b""
            if isinstance(partial, bytes):
                partial = partial.decode(errors="replace")
            for line in str(partial).splitlines():
                log(f"  {line}")
            log(f"[TILE_TIMEOUT] {tile_id}: {args.tile_timeout_seconds}s")

        marker = tile_builder.validate_complete(tile_data, tile_marker, tuple(bbox))
        if marker is not None:
            state["inFlight"] = None
            state["tileResults"][tile_id] = {
                "status": "complete",
                "attempts": attempt,
                "sha256": marker["sha256"],
                "completedAt": utc_now(),
            }
            state["failedTiles"].pop(tile_id, None)
            state["lastPosition"] = tile_id
            state["status"] = "running"
            write_state(state_path, state)
            log(
                f"[TILE_COMPLETE] {tile_id} roads={marker['roadFeatureCount']} "
                f"coords={marker['coordinateCount']} bytes={marker['sizeBytes']} sha256={marker['sha256']}"
            )
            return True

        reason = f"builder_exit={return_code}, marker_valid={marker is not None}"
        log(f"[TILE_ERROR] {tile_id} attempt={attempt}: {reason}")
        state["inFlight"] = None
        state["tileAttempts"][tile_id] = attempt
        state["tileResults"][tile_id] = {
            "status": "attempt-failed",
            "attempts": attempt,
            "reason": reason,
            "updatedAt": utc_now(),
        }
        write_state(state_path, state)
        if attempt == 2:
            state["failedTiles"][tile_id] = {
                "attempts": attempt,
                "reason": reason,
                "bbox": bbox,
            }
            state["status"] = "paused-failure"
            write_state(state_path, state)
            return False
        log(f"[TILE_RETRY] {tile_id}: 실패한 타일만 한 번 재시도합니다.")
    return False


def run(args: argparse.Namespace) -> int:
    state_dir = args.state_dir.expanduser().resolve()
    plans_dir = state_dir / "plans"
    state_path = state_dir / "state.json"
    log_path = state_dir / "run.log"
    lock_path = state_dir / "run.lock"
    state_dir.mkdir(parents=True, exist_ok=True)
    plans_dir.mkdir(parents=True, exist_ok=True)

    with RunLock(lock_path):
        state = read_state(state_path)
        log_file = log_path.open("a", encoding="utf-8")

        def log(message: str) -> None:
            line = f"{utc_now()} {message}"
            print(line, flush=True)
            log_file.write(line + "\n")
            log_file.flush()

        reconcile_interrupted_state(state, args, log, state_path)
        started = time.monotonic()
        batches_this_run = 0
        try:
            while True:
                if (
                    args.max_batches is not None
                    and batches_this_run >= args.max_batches
                ):
                    state["status"] = "paused-batch-limit"
                    write_state(state_path, state)
                    log(
                        f"배치 제한 {args.max_batches}에 도달해 배치 경계에서 안전 종료합니다."
                    )
                    return 0

                plan_path, plan = make_plan(args, plans_dir, log)
                state["totalTiles"] = plan["totalTiles"]
                state["completedTiles"] = plan["completedTiles"]
                state["remainingTiles"] = plan["remainingTiles"]
                write_state(state_path, state)

                if plan["remainingTiles"] == 0:
                    state["status"] = "complete"
                    write_state(state_path, state)
                    log("모든 행정경계 교차 타일이 검증 완료되었습니다.")
                    return 0

                exhausted = [
                    tile_id
                    for tile_id, record in state["failedTiles"].items()
                    if record.get("attempts", 0) >= 2
                ]
                if exhausted:
                    state["status"] = "paused-failure"
                    write_state(state_path, state)
                    log(
                        f"재시도 한도에 도달한 실패 타일이 있어 중단합니다: {exhausted}"
                    )
                    return 1

                remaining_boxes = plan["remainingTileBBoxes"]
                batch_boxes = remaining_boxes[: args.batch_size]
                if not batch_boxes:
                    state["status"] = "complete"
                    write_state(state_path, state)
                    return 0

                elapsed = time.monotonic() - started
                mean = float(plan.get("estimatedSecondsPerTileMean") or 30.0)
                expected_batch = len(batch_boxes) * mean
                if (
                    batches_this_run
                    and elapsed + expected_batch > args.max_runtime_seconds
                ):
                    state["status"] = "paused-time-budget"
                    write_state(state_path, state)
                    log(
                        f"남은 실행 예산으로 다음 {len(batch_boxes)}개 타일을 마칠 수 없어 "
                        "현재 배치 경계에서 안전 종료합니다."
                    )
                    return 0

                batch_number = len(state["batches"]) + 1
                batch = {
                    "batchNumber": batch_number,
                    "startedAt": utc_now(),
                    "status": "running",
                    "tileIds": [
                        tile_builder.tile_name(tuple(bbox)) for bbox in batch_boxes
                    ],
                    "completedTileIds": [],
                    "failedTileIds": [],
                }
                state["batches"].append(batch)
                state["status"] = "running"
                write_state(state_path, state)
                log(
                    f"[BATCH_START] #{batch_number} {len(batch_boxes)} tiles · "
                    f"remaining={plan['remainingTiles']} · limit={args.max_runtime_seconds}s"
                )

                batch_failed = False
                for index, bbox in enumerate(batch_boxes, start=1):
                    tile_id = tile_builder.tile_name(tuple(bbox))
                    marker = tile_builder.validate_complete(
                        *tile_builder.tile_paths(args.output_dir, tuple(bbox)),
                        tuple(bbox),
                    )
                    if marker is not None:
                        batch["completedTileIds"].append(tile_id)
                        log(
                            f"[{index}/{len(batch_boxes)}] SHA-256 검증된 타일 건너뜀: {tile_id}"
                        )
                        state["completedTiles"] = min(
                            state["totalTiles"], state["completedTiles"] + 1
                        )
                        state["remainingTiles"] = max(0, state["remainingTiles"] - 1)
                        write_state(state_path, state)
                        continue
                    if not execute_tile(
                        args,
                        plan,
                        plan_path,
                        bbox,
                        tile_id,
                        state,
                        state_path,
                        log,
                    ):
                        batch["failedTileIds"].append(tile_id)
                        batch_failed = True
                        break
                    batch["completedTileIds"].append(tile_id)
                    state["completedTiles"] = min(
                        state["totalTiles"], state["completedTiles"] + 1
                    )
                    state["remainingTiles"] = max(0, state["remainingTiles"] - 1)
                    write_state(state_path, state)

                batch["finishedAt"] = utc_now()
                batch["status"] = "failed" if batch_failed else "complete"
                write_state(state_path, state)
                batches_this_run += 1
                log(
                    f"[BATCH_END] #{batch_number} status={batch['status']} "
                    f"completed={len(batch['completedTileIds'])} failed={len(batch['failedTileIds'])}"
                )
                if batch_failed:
                    state["status"] = "paused-failure"
                    write_state(state_path, state)
                    return 1
                if time.monotonic() - started >= args.max_runtime_seconds:
                    state["status"] = "paused-time-budget"
                    write_state(state_path, state)
                    log("시간 예산에 도달해 완료된 배치 경계에서 안전 종료합니다.")
                    return 0
        except Exception as error:
            state["status"] = "paused-error"
            state["lastError"] = f"{type(error).__name__}: {error}"
            write_state(state_path, state)
            log(f"[RUNNER_ERROR] {type(error).__name__}: {error}")
            if args.debug:
                log(traceback.format_exc())
            return 1
        finally:
            log_file.close()


def dry_run(args: argparse.Namespace) -> int:
    with tempfile.TemporaryDirectory(prefix="changwon-tile-plan-") as temp_dir:
        args.state_dir = Path(temp_dir) / "state"
        args.max_batches = 1
        state_dir = args.state_dir
        plans_dir = state_dir / "plans"
        plans_dir.mkdir(parents=True)
        plan_path, plan = make_plan(
            args, plans_dir, lambda message: print(message, flush=True)
        )
        print(
            f"DRY RUN: remaining={plan['remainingTiles']} first_batch="
            f"{[tile_builder.tile_name(tuple(b)) for b in plan['remainingTileBBoxes'][: args.batch_size]]}"
        )
        return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="창원 OSM 잔여 타일을 잠금·재개·재시도로 자동 처리합니다."
    )
    parser.add_argument("--input", type=Path, default=DEFAULT_INPUT)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_TILE_DIR)
    parser.add_argument("--boundary-cache", type=Path, default=DEFAULT_BOUNDARY_CACHE)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--batch-size", type=int, choices=(4, 5, 6), default=5)
    parser.add_argument("--max-runtime-seconds", type=int, default=300)
    parser.add_argument("--tile-timeout-seconds", type=int, default=120)
    parser.add_argument("--max-batches", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    if args.max_runtime_seconds < 60 or args.tile_timeout_seconds < 30:
        parser.error("시간 제한이 너무 짧습니다 (runtime>=60s, tile-timeout>=30s).")
    if args.max_batches is not None and args.max_batches < 1:
        parser.error("--max-batches는 1 이상이어야 합니다.")
    return args


def main() -> int:
    args = parse_args()
    if args.dry_run:
        return dry_run(args)
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
