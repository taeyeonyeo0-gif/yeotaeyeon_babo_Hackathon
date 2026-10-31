#!/usr/bin/env python3
"""Choose and create one Gimhae tile using the existing tile builder."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_changwon_road_tiles as builder


ROOT = Path(__file__).resolve().parent
PBF = ROOT / "south-korea-261025.osm.pbf"
PBF_SHA256 = "395e4e7cdbad3eea862227cb6290433efef274959a6deaf7f15916d17f2f2b2b"
PBF_SIZE = 290_087_135
CITY_DIR = ROOT / "data" / "generated" / "changwon-city"
TILE_DIR = CITY_DIR / "tiles"
MANIFEST = CITY_DIR / "manifest.json"
GIMHAE_CACHE = (
    ROOT / "data" / "generated" / "gimhae-city" / "cache" / "gimhae-boundary.geojson"
)
GRID_SIZE = 0.04


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def digest(path: Path) -> str:
    return builder.sha256_file(path)


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{time.time_ns()}.part")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as output:
            json.dump(
                value,
                output,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def edge_adjacent(a: tuple[float, ...], b: tuple[float, ...]) -> bool:
    x_overlap = min(a[2], b[2]) - max(a[0], b[0])
    y_overlap = min(a[3], b[3]) - max(a[1], b[1])
    vertical = (
        math.isclose(a[2], b[0], abs_tol=1e-8) or math.isclose(b[2], a[0], abs_tol=1e-8)
    ) and y_overlap > 1e-8
    horizontal = (
        math.isclose(a[3], b[1], abs_tol=1e-8) or math.isclose(b[3], a[1], abs_tol=1e-8)
    ) and x_overlap > 1e-8
    return vertical or horizontal


def region_tiles(boundary: Any) -> list[tuple[float, float, float, float]]:
    from shapely.geometry import box

    min_x, min_y, max_x, max_y = boundary.bounds
    origin_x, origin_y = builder.BASE_BBOX[:2]
    c0, c1 = (
        math.floor((min_x - origin_x) / GRID_SIZE),
        math.ceil((max_x - origin_x) / GRID_SIZE) - 1,
    )
    r0, r1 = (
        math.floor((min_y - origin_y) / GRID_SIZE),
        math.ceil((max_y - origin_y) / GRID_SIZE) - 1,
    )
    output = []
    for row in range(r0, r1 + 1):
        for col in range(c0, c1 + 1):
            west, south = (
                round(origin_x + col * GRID_SIZE, 8),
                round(origin_y + row * GRID_SIZE, 8),
            )
            tile = (
                west,
                south,
                round(west + GRID_SIZE, 8),
                round(south + GRID_SIZE, 8),
            )
            if boundary.intersection(box(*tile)).area > 1e-12:
                output.append(tile)
    return output


def verified_manifest() -> tuple[
    dict[str, Any], dict[str, tuple[float, ...]], dict[str, str]
]:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if manifest.get("schema") != "changwon-osm-road-tiles-v1":
        raise ValueError("기존 manifest 스키마가 예상과 다릅니다.")
    expansion_ids = set(manifest.get("gimhaeExpansion", {}).get("tileIds", []))
    all_entries = [manifest["baseTile"], *manifest["tiles"]]
    completed: dict[str, tuple[float, ...]] = {}
    old_hashes: dict[str, str] = {}
    old_count = 0
    for entry in all_entries:
        bbox = tuple(float(value) for value in entry["bbox"])
        name = builder.tile_name(bbox)
        data_path, marker_path = builder.tile_paths(TILE_DIR, bbox)
        marker = builder.validate_complete(data_path, marker_path, bbox)
        if marker is None or marker.get("sha256") != entry.get("sha256"):
            raise ValueError(f"완료 타일 또는 SHA-256 검증 실패: {name}")
        completed[name] = bbox
        if name not in expansion_ids:
            old_hashes[name] = marker["sha256"]
            old_count += 1
    if old_count != 84 or len(completed) != len(all_entries):
        raise ValueError(f"기존 창원 완료 타일 84개 검증 실패: {old_count}")
    return manifest, completed, old_hashes


def select_one_tile(
    gimhae: Any, changwon: Any, completed: dict[str, tuple[float, ...]]
) -> tuple[float, ...]:
    from shapely.geometry import box

    representative = gimhae.representative_point()
    candidates = []
    for tile in region_tiles(gimhae):
        name = builder.tile_name(tile)
        if name in completed:
            continue
        data_path, marker_path = builder.tile_paths(TILE_DIR, tile)
        if data_path.exists() or marker_path.exists():
            raise ValueError(
                f"manifest 밖에 기존 타일 파일이 있어 덮어쓰지 않습니다: {name}"
            )
        geometry = box(*tile)
        if changwon.intersection(geometry).area > 1e-12:
            continue
        if not any(edge_adjacent(tile, done) for done in completed.values()):
            continue
        area = gimhae.intersection(geometry).area
        if area > 1e-12:
            candidates.append((geometry.distance(representative), -area, tile))
    if not candidates:
        raise ValueError("창원 완료 타일과 맞닿은 김해 미완료 타일이 없습니다.")
    candidates.sort(key=lambda item: (item[0], item[1], item[2][1], item[2][0]))
    return candidates[0][2]


def append_manifest(
    manifest: dict[str, Any], tile: tuple[float, ...], marker: dict[str, Any]
) -> None:
    current = json.loads(MANIFEST.read_text(encoding="utf-8"))
    name = builder.tile_name(tile)
    if any(entry.get("id") == name for entry in current["tiles"]):
        return
    if current.get("baseTile") != manifest.get("baseTile"):
        raise ValueError("기준 타일 manifest 항목이 바뀌어 중단합니다.")
    original_entries = {entry["id"]: entry for entry in manifest["tiles"]}
    for entry in current["tiles"]:
        if entry["id"] in original_entries and entry != original_entries[entry["id"]]:
            raise ValueError(f"기존 manifest 항목이 변경되었습니다: {entry['id']}")
    entry = {
        "id": name,
        "file": f"tiles/{marker['file']}",
        "bbox": list(tile),
        "featureCount": marker["roadFeatureCount"],
        "coordinateCount": marker["coordinateCount"],
        "bytes": marker["sizeBytes"],
        "sha256": marker["sha256"],
        "generatedAt": marker["generatedAt"],
        "region": "김해시",
    }
    current["tiles"].append(entry)
    current["region"] = "창원시 및 인접 김해시"
    current["expectedNeighborTileCount"] = len(current["tiles"])
    current["completeNeighborTileCount"] = len(current["tiles"])
    bounds = [tuple(item["bbox"]) for item in current["tiles"]]
    bounds.append(tuple(current["baseTile"]["bbox"]))
    current["availableBounds"] = [
        min(item[0] for item in bounds),
        min(item[1] for item in bounds),
        max(item[2] for item in bounds),
        max(item[3] for item in bounds),
    ]
    expansion_ids = sorted(
        set(current.get("gimhaeExpansion", {}).get("tileIds", [])) | {name}
    )
    current["gimhaeExpansion"] = {"tileIds": expansion_ids}
    current["coverageNote"] = (
        f"기준 1개, 기존 창원 83개, 인접 김해 {len(expansion_ids)}개 타일을 포함합니다."
    )
    current["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    atomic_json(MANIFEST, current)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="김해 인접 타일 하나를 기존 생성기로 추가합니다."
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="타일만 선정하고 도로는 생성하지 않음"
    )
    parser.add_argument("--debug", action="store_true")
    args = parser.parse_args()
    started = time.perf_counter()
    try:
        if (
            not PBF.is_file()
            or PBF.stat().st_size != PBF_SIZE
            or digest(PBF) != PBF_SHA256
        ):
            raise ValueError("기존 PBF 크기 또는 SHA-256 검증 실패")
        manifest, completed, old_hashes = verified_manifest()
        expansion = manifest.get("gimhaeExpansion", {}).get("tileIds", [])
        if expansion:
            raise ValueError(
                "이미 김해 확장 타일이 있습니다. 이번 실행은 새 타일을 추가하지 않습니다."
            )

        progress_last = [-10]

        def report(done: int, total: int) -> None:
            if total:
                percent = int(done * 100 / total)
                if percent >= progress_last[0] + 10 or percent == 100:
                    log(f"PBF 경계 읽기 {percent}%")
                    progress_last[0] = percent

        changwon = builder.load_city_boundary(
            PBF, builder.DEFAULT_BOUNDARY_CACHE, log, report
        )
        gimhae = builder.load_city_boundary(
            PBF, GIMHAE_CACHE, log, report, region_name="김해시", admin_level="6"
        )
        tile = select_one_tile(gimhae, changwon, completed)
        name = builder.tile_name(tile)
        print(f"선정 타일: {name} {list(tile)}")
        if args.dry_run:
            print("DRY_RUN=true; 도로 추출·파일 저장·manifest 변경은 하지 않았습니다.")
            return 0

        tile_args = argparse.Namespace(
            input=PBF,
            output_dir=TILE_DIR,
            boundary_cache=GIMHAE_CACHE,
            tile_bbox=list(tile),
            region_name="김해시",
            admin_level="6",
            debug=args.debug,
        )
        if builder.process_single_tile(tile_args) != 0:
            raise RuntimeError("기존 단일 타일 생성기가 실패했습니다.")
        data_path, marker_path = builder.tile_paths(TILE_DIR, tile)
        marker = builder.validate_complete(data_path, marker_path, tile)
        if marker is None:
            raise ValueError("신규 타일 SHA-256 완료 표식 검증 실패")
        collection = json.loads(data_path.read_text(encoding="utf-8"))
        if collection.get("meta", {}).get("region") != "김해시":
            raise ValueError("신규 타일의 행정구역 메타데이터가 김해시가 아닙니다.")
        if marker["roadFeatureCount"] <= 0:
            raise ValueError("선정된 김해 타일에서 보행 도로를 찾지 못했습니다.")

        append_manifest(manifest, tile, marker)
        after = json.loads(MANIFEST.read_text(encoding="utf-8"))
        for entry in [after["baseTile"], *after["tiles"]]:
            current_id = entry["id"]
            if current_id not in old_hashes:
                continue
            if entry.get("sha256") != old_hashes[current_id]:
                raise ValueError(f"기존 창원 manifest 타일 SHA 변경: {current_id}")
            bbox = tuple(entry["bbox"])
            if (
                builder.validate_complete(*builder.tile_paths(TILE_DIR, bbox), bbox)
                is None
            ):
                raise ValueError(f"기존 완료 타일 무결성 변경: {current_id}")

        meta = collection["meta"]
        print(
            f"RESULT roads={meta['roadFeatureCount']} coordinates={meta['coordinateCount']} "
            f"processingSeconds={meta['processingSeconds']} bytes={marker['sizeBytes']} "
            f"sha256={marker['sha256']} totalSeconds={time.perf_counter() - started:.2f}"
        )
        return 0
    except Exception as error:
        log(f"[오류] {type(error).__name__}: {error}")
        if args.debug:
            import traceback

            traceback.print_exc()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
