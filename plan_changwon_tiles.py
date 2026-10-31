#!/usr/bin/env python3
"""Read-only planner for remaining Changwon OSM display tiles."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import statistics
from pathlib import Path
from typing import Any

from build_changwon_road_tiles import (
    BASE_BBOX,
    DEFAULT_BOUNDARY_CACHE,
    DEFAULT_MANIFEST,
    DEFAULT_OUTPUT,
    tile_name,
    validate_complete,
)


ROOT = Path(__file__).resolve().parent
CELL_SIZE = 0.04


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="창원시 행정경계와 검증된 타일을 기준으로 남은 도로 타일을 읽기 전용으로 계산합니다."
    )
    parser.add_argument("--batch-size", type=int, choices=(4, 5, 6), default=5)
    parser.add_argument("--boundary-cache", type=Path, default=DEFAULT_BOUNDARY_CACHE)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--tile-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--write-list",
        type=Path,
        help="검증된 잔여 목록을 새 JSON 파일로 내보냄 (기존 파일은 덮어쓰지 않음)",
    )
    return parser.parse_args()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def coordinate_count(value: Any) -> int:
    if not isinstance(value, (list, tuple)) or not value:
        return 0
    if isinstance(value[0], (int, float)):
        return 1
    return sum(coordinate_count(child) for child in value)


def load_boundary(path: Path) -> Any:
    from shapely.geometry import shape

    marker_path = path.with_suffix(".complete.json")
    if not path.is_file() or not marker_path.is_file():
        raise FileNotFoundError("검증된 행정경계 캐시 또는 완료 표식이 없습니다.")
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    if (
        marker.get("complete") is not True
        or marker.get("sizeBytes") != path.stat().st_size
        or marker.get("sha256") != sha256_file(path)
    ):
        raise ValueError("행정경계 캐시 크기 또는 SHA-256 검증에 실패했습니다.")
    data = json.loads(path.read_text(encoding="utf-8"))
    feature = data["features"][0]
    boundary = shape(feature["geometry"])
    if (
        data.get("type") != "FeatureCollection"
        or feature["properties"].get("name") != "창원시"
        or feature["properties"].get("admin_level") != "6"
        or boundary.is_empty
        or not boundary.is_valid
        or list(boundary.bounds) != marker.get("bounds")
    ):
        raise ValueError("행정경계 캐시 도형을 검증할 수 없습니다.")
    return boundary


def completed_tile(
    bbox: tuple[float, float, float, float],
    tile_dir: Path,
    manifest_entries: dict[str, dict[str, Any]],
    base_entry: dict[str, Any] | None,
) -> tuple[bool, str, float | None]:
    data_path = tile_dir / f"{tile_name(bbox)}.geojson"
    marker_path = tile_dir / f"{tile_name(bbox)}.complete.json"
    marker = validate_complete(data_path, marker_path, bbox)
    if marker is None:
        present = data_path.exists() or marker_path.exists()
        return False, "invalid/incomplete" if present else "missing", None
    entry = (
        base_entry
        if marker["tileId"] == (base_entry or {}).get("id")
        else manifest_entries.get(marker["tileId"])
    )
    if (
        not entry
        or entry.get("bbox") != marker.get("bbox")
        or entry.get("sha256") != marker.get("sha256")
    ):
        return False, "valid files but missing/mismatched manifest", None

    log_path = tile_dir / f"{tile_name(bbox)}.log"
    elapsed = None
    if log_path.is_file():
        matches = re.findall(
            r"완료: elapsed=([0-9.]+)s", log_path.read_text(encoding="utf-8")
        )
        if matches:
            elapsed = float(matches[-1])
    if elapsed is None:
        data = json.loads(data_path.read_text(encoding="utf-8"))
        elapsed = float(data["meta"].get("processingSeconds", 0)) or None
    return True, "complete and verified", elapsed


def main() -> int:
    args = parse_args()
    try:
        from shapely.geometry import box
    except ImportError as error:
        print(f"[계획 오류] Shapely를 찾지 못했습니다: {error}")
        return 1
    boundary_path = args.boundary_cache.expanduser().resolve()
    manifest_path = args.manifest.expanduser().resolve()
    tile_dir = args.tile_dir.expanduser().resolve()

    try:
        boundary = load_boundary(boundary_path)
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest.get("schema") != "changwon-osm-road-tiles-v1":
            raise ValueError("현재 manifest 스키마가 예상과 다릅니다.")
        manifest_entries = {tile["id"]: tile for tile in manifest.get("tiles", [])}
        base_entry = manifest.get("baseTile")

        min_x, min_y, max_x, max_y = boundary.bounds
        origin_x, origin_y = BASE_BBOX[0], BASE_BBOX[1]
        min_col = math.floor((min_x - origin_x) / CELL_SIZE)
        max_col = math.ceil((max_x - origin_x) / CELL_SIZE) - 1
        min_row = math.floor((min_y - origin_y) / CELL_SIZE)
        max_row = math.ceil((max_y - origin_y) / CELL_SIZE) - 1

        all_tiles = []
        for row in range(min_row, max_row + 1):
            for col in range(min_col, max_col + 1):
                west = round(origin_x + col * CELL_SIZE, 8)
                south = round(origin_y + row * CELL_SIZE, 8)
                bbox = (
                    west,
                    south,
                    round(west + CELL_SIZE, 8),
                    round(south + CELL_SIZE, 8),
                )
                intersection = boundary.intersection(box(*bbox))
                if not intersection.is_empty and intersection.area > 0:
                    all_tiles.append(bbox)

        completed = []
        remaining = []
        invalid = []
        times = []
        for bbox in all_tiles:
            done, state, elapsed = completed_tile(
                bbox, tile_dir, manifest_entries, base_entry
            )
            if done:
                completed.append(bbox)
                if elapsed and bbox != BASE_BBOX:
                    times.append(elapsed)
            else:
                remaining.append(bbox)
                if state != "missing":
                    invalid.append((bbox, state))

        measured_count = len(times)
        mean_seconds = statistics.fmean(times) if times else None
        median_seconds = statistics.median(times) if times else None
        min_seconds, max_seconds = (min(times), max(times)) if times else (None, None)
        print(f"경계 캐시: {boundary_path} (SHA-256 검증 완료)")
        print(f"격자: 0.04도 · 원점 [{origin_x:.2f}, {origin_y:.2f}]")
        print(f"전체 행정경계 교차 타일: {len(all_tiles)}")
        print(f"완료 및 검증된 타일: {len(completed)}")
        print(f"남은 추출 타일: {len(remaining)}")
        print(f"불완전/manifest 불일치: {len(invalid)}")
        print(f"manifest 타일: {len(manifest_entries)} + 기준 타일")
        print(
            f"실측 완료 확장 타일 처리시간 표본: {measured_count} "
            "(중앙 타일 최초 경계 조회시간은 제외)"
        )
        if (
            mean_seconds is not None
            and median_seconds is not None
            and min_seconds is not None
            and max_seconds is not None
        ):
            print(
                f"실측 시간(추정 기준): 평균 {mean_seconds:.2f}s, 중앙값 {median_seconds:.2f}s, "
                f"범위 {min_seconds:.2f}–{max_seconds:.2f}s/타일"
            )
            print(
                f"남은 시간 추정: 평균 기준 {len(remaining) * mean_seconds / 60:.1f}분 "
                f"(실측 최소·최대 기준 {len(remaining) * min_seconds / 60:.1f}–{len(remaining) * max_seconds / 60:.1f}분)"
            )
            print(
                "시간은 경계 캐시가 재사용되고 각 타일의 PBF 읽기 시간이 기존 실측과 비슷하다는 가정의 추정치입니다."
            )
        if invalid:
            print("검토가 필요한 기존 파일:")
            for bbox, state in invalid:
                print(f"  {tile_name(bbox)} {bbox}: {state}")

        cache_marker = json.loads(
            boundary_path.with_suffix(".complete.json").read_text(encoding="utf-8")
        )
        plan = {
            "schema": "changwon-remaining-tile-plan-v1",
            "region": "창원시",
            "cellSizeDegrees": CELL_SIZE,
            "gridOrigin": [origin_x, origin_y],
            "boundaryCache": str(boundary_path),
            "boundaryCacheSha256": cache_marker["sha256"],
            "manifest": str(manifest_path),
            "totalTiles": len(all_tiles),
            "completedTiles": len(completed),
            "remainingTiles": len(remaining),
            "invalidTiles": [
                {"id": tile_name(bbox), "bbox": list(bbox), "status": state}
                for bbox, state in invalid
            ],
            "allTileBBoxes": [list(bbox) for bbox in all_tiles],
            "verifiedTileBBoxes": [list(bbox) for bbox in completed],
            "remainingTileBBoxes": [list(bbox) for bbox in remaining],
            "batchSize": args.batch_size,
            "measuredTileSeconds": times,
            "estimatedSecondsPerTileMean": mean_seconds,
            "estimatedRemainingSecondsMean": (
                len(remaining) * mean_seconds if mean_seconds is not None else None
            ),
        }
        if args.write_list:
            plan_path = args.write_list.expanduser().resolve()
            if plan_path.exists():
                raise FileExistsError(
                    f"계획 파일이 이미 있습니다. 덮어쓰지 않습니다: {plan_path}"
                )
            with plan_path.open("x", encoding="utf-8", newline="\n") as output:
                json.dump(plan, output, ensure_ascii=False, indent=2, allow_nan=False)
                output.write("\n")
            print(f"잔여 타일 계획 파일 생성: {plan_path}")

        print(f"남은 작업을 {args.batch_size}개씩 묶은 계획:")
        for start in range(0, len(remaining), args.batch_size):
            group = remaining[start : start + args.batch_size]
            print(f"  배치 {start // args.batch_size + 1}: {len(group)}개")
            for bbox in group:
                print(f"    {tile_name(bbox)} {list(bbox)}")
                print(
                    "      python build_changwon_road_tiles.py --tile-bbox "
                    + " ".join(f"{value:.2f}" for value in bbox)
                    + " --output-dir data/generated/changwon-city/tiles"
                    + " --boundary-cache data/generated/changwon-city/cache/changwon-boundary.geojson"
                )
        if remaining:
            print(
                "이번 계획은 읽기 전용입니다. PBF 도로 추출이나 파일 쓰기는 수행하지 않았습니다."
            )
        print("다음 계획 계산 명령: python plan_changwon_tiles.py --batch-size 5")
        return 0
    except Exception as error:
        print(f"[계획 오류] {type(error).__name__}: {error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
