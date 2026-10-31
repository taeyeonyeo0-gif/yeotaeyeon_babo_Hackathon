#!/usr/bin/env python3
"""Read one bounded OSM road batch and split it into 0.04-degree tiles."""

from __future__ import annotations

import argparse
import json
import math
import os
import tempfile
import time
import traceback
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import build_changwon_road_tiles as tile_builder


ROOT = Path(__file__).resolve().parent
DEFAULT_BATCH_BBOX = (126.90, 37.48, 127.06, 37.64)
TILE_SIZE = 0.04
TAGS_TO_KEEP = ["access", "foot", "footway", "highway", "name", "surface"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="한 번의 경계 제한된 PBF 읽기로 소수 OSM 도로 타일을 만듭니다."
    )
    parser.add_argument("--input", type=Path, default=tile_builder.DEFAULT_INPUT)
    parser.add_argument(
        "--batch-bbox",
        type=float,
        nargs=4,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        default=DEFAULT_BATCH_BBOX,
        help="한 번만 PBF 도로망을 읽을 사각 배치 경계",
    )
    parser.add_argument("--tile-size-degrees", type=float, default=TILE_SIZE)
    parser.add_argument("--region-name", default="대한민국", help="경계 relation name")
    parser.add_argument("--admin-level", default="2", help="행정 경계 수준")
    parser.add_argument("--region-id", default="korea", help="지역 식별자")
    parser.add_argument("--boundary-cache", type=Path)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ROOT / "data" / "generated" / "korea-road-tiles" / "tiles",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=ROOT / "data" / "generated" / "korea-road-tiles" / "manifest.json",
    )
    parser.add_argument(
        "--benchmark-only",
        action="store_true",
        help="후보 타일을 임시 폴더에 저장·검증하고 기존 타일과 비교만 수행",
    )
    parser.add_argument("--debug", action="store_true")
    return parser.parse_args()


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).isoformat(timespec="seconds")
    print(f"{stamp} {message}", flush=True)


def load_region_boundary(
    input_path: Path,
    cache_path: Path,
    region_name: str,
    admin_level: str,
    region_id: str,
    log_fn: Any,
    progress_fn: Any,
) -> Any:
    from pyrosm import OSM
    from shapely.geometry import mapping, shape

    marker_path = cache_path.with_suffix(".complete.json")
    if cache_path.is_file() and marker_path.is_file():
        try:
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            cache = json.loads(cache_path.read_text(encoding="utf-8"))
            feature = cache["features"][0]
            boundary = shape(feature["geometry"])
            if (
                marker.get("complete") is True
                and marker.get("name") == region_name
                and marker.get("adminLevel") == admin_level
                and marker.get("sha256") == tile_builder.sha256_file(cache_path)
                and marker.get("sizeBytes") == cache_path.stat().st_size
                and cache.get("type") == "FeatureCollection"
                and feature["properties"].get("name") == region_name
                and feature["properties"].get("admin_level") == admin_level
                and boundary.is_valid
                and not boundary.is_empty
                and list(boundary.bounds) == marker.get("bounds")
            ):
                log_fn(f"[BOUNDARY_CACHE_HIT] {cache_path} sha256={marker['sha256']}")
                return boundary
            log_fn(f"[BOUNDARY_CACHE_ERROR] 검증 불일치: {cache_path}")
        except Exception as error:
            log_fn(f"[BOUNDARY_CACHE_ERROR] {type(error).__name__}: {error}")
    else:
        log_fn(f"[BOUNDARY_CACHE_MISS] {cache_path}")

    log_fn(
        f"[BOUNDARY_PBF] 외부 네트워크 없이 로컬 PBF 경계만 조회: "
        f"{region_name} admin_level={admin_level}"
    )
    reader = OSM(str(input_path), engine="out_of_core", workers=1, progress=progress_fn)
    matches = reader.get_boundaries(boundary_type="administrative", name=region_name)
    if matches is None or matches.empty or "geometry" not in matches.columns:
        raise ValueError(f"PBF 행정경계를 찾지 못했습니다: {region_name}")
    if "admin_level" in matches.columns:
        matches = matches[matches["admin_level"].astype(str) == admin_level]
    if matches.empty:
        raise ValueError(
            f"행정경계 수준이 일치하지 않습니다: {region_name}/{admin_level}"
        )
    boundary = matches.geometry.union_all()
    if boundary.is_empty or not boundary.is_valid:
        raise ValueError(f"행정경계 도형이 비었거나 유효하지 않습니다: {region_name}")

    generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    collection = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "properties": {"name": region_name, "admin_level": admin_level},
                "geometry": mapping(boundary),
            }
        ],
        "meta": {
            "regionId": region_id,
            "source": "OpenStreetMap PBF",
            "sourceDate": tile_builder.snapshot_date(input_path),
            "generatedAt": generated_at,
        },
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temp_cache = cache_path.with_name(f".{cache_path.name}.{os.getpid()}.part")
    temp_marker = marker_path.with_name(f".{marker_path.name}.{os.getpid()}.part")
    with temp_cache.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(
            collection,
            output,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    marker = {
        "complete": True,
        "regionId": region_id,
        "name": region_name,
        "adminLevel": admin_level,
        "bounds": list(boundary.bounds),
        "sizeBytes": temp_cache.stat().st_size,
        "sha256": tile_builder.sha256_file(temp_cache),
        "generatedAt": generated_at,
    }
    with temp_marker.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(
            marker, output, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temp_cache, cache_path)
    os.replace(temp_marker, marker_path)
    log_fn(f"[BOUNDARY_CACHE_SAVED] {cache_path} sha256={marker['sha256']}")
    return boundary


def grid_tiles(
    bbox: tuple[float, float, float, float],
    boundary: Any,
    size: float,
) -> list[tuple[float, float, float, float]]:
    west, south, east, north = bbox
    origin_x, origin_y = tile_builder.BASE_BBOX[:2]
    col0 = round((west - origin_x) / size)
    col1 = round((east - origin_x) / size)
    row0 = round((south - origin_y) / size)
    row1 = round((north - origin_y) / size)
    if any(
        abs(value - round(value)) > 1e-8
        for value in (
            (west - origin_x) / size,
            (east - origin_x) / size,
            (south - origin_y) / size,
            (north - origin_y) / size,
        )
    ):
        raise ValueError("배치 경계가 기존 0.04도 격자와 맞지 않습니다.")
    if col1 <= col0 or row1 <= row0:
        raise ValueError("배치 경계의 폭 또는 높이가 올바르지 않습니다.")

    from shapely.geometry import box

    result = []
    for row in range(row0, row1):
        for col in range(col0, col1):
            x0 = round(origin_x + col * size, 8)
            y0 = round(origin_y + row * size, 8)
            tile = (x0, y0, round(x0 + size, 8), round(y0 + size, 8))
            if boundary.intersection(box(*tile)).area > 0:
                result.append(tile)
    return result


def line_parts(geometry: Any):
    if geometry is None or geometry.is_empty:
        return
    if geometry.geom_type == "LineString":
        if geometry.length > 0:
            yield geometry
    elif geometry.geom_type in {"MultiLineString", "GeometryCollection"}:
        for part in geometry.geoms:
            yield from line_parts(part)


def canonical_feature(feature: dict[str, Any]) -> str:
    props = feature.get("properties", {})
    coordinates = tuple(
        (round(float(point[0]), 8), round(float(point[1]), 8))
        for point in feature.get("geometry", {}).get("coordinates", [])
    )
    reverse = tuple(reversed(coordinates))
    if reverse < coordinates:
        coordinates = reverse
    stable_props = tuple(
        (key, props.get(key, "")) for key in ("osmId", "highway", "name", "surface")
    )
    return json.dumps(
        [stable_props, coordinates], ensure_ascii=False, separators=(",", ":")
    )


def build_collections(
    roads: Any,
    boundary: Any,
    batch_bbox: tuple[float, float, float, float],
    tiles: list[tuple[float, float, float, float]],
    input_path: Path,
    network_seconds: float,
    region_name: str,
) -> tuple[dict[tuple[float, float, float, float], dict[str, Any]], dict[str, Any]]:
    from shapely.geometry import box

    batch_polygon = box(*batch_bbox)
    clip_region = boundary.intersection(batch_polygon)
    feature_map: dict[tuple[float, float, float, float], list[dict[str, Any]]] = {
        tile: [] for tile in tiles
    }
    way_ids: dict[tuple[float, float, float, float], set[str]] = {
        tile: set() for tile in tiles
    }
    actual_bounds: dict[
        tuple[float, float, float, float], list[tuple[float, float, float, float]]
    ] = {tile: [] for tile in tiles}
    coordinate_totals = {tile: 0 for tile in tiles}

    if roads is None:
        rows = ()
        source_count = 0
    else:
        if "geometry" not in roads.columns or "id" not in roads.columns:
            raise ValueError("Pyrosm 결과에 geometry 또는 OSM id가 없습니다.")
        rows = roads.iterrows()
        source_count = len(roads)

    from shapely.geometry import box as tile_box

    tile_polygons = {tile: tile_box(*tile) for tile in tiles}
    for _, row in rows:
        geometry = row.get("geometry")
        if geometry is None or geometry.is_empty:
            continue
        clipped_city = geometry.intersection(clip_region)
        if clipped_city.is_empty:
            continue
        way_id = tile_builder.value(row, "id")
        if not way_id:
            continue
        properties = {
            "osmId": f"way/{way_id}",
            "highway": tile_builder.value(row, "highway"),
            "name": tile_builder.value(row, "name"),
            "surface": tile_builder.value(row, "surface"),
        }
        for line in line_parts(clipped_city):
            min_x, min_y, max_x, max_y = line.bounds
            for tile in tiles:
                west, south, east, north = tile
                if max_x < west or min_x > east or max_y < south or min_y > north:
                    continue
                piece_geometry = line.intersection(tile_polygons[tile])
                for piece in line_parts(piece_geometry):
                    coordinates = [[float(x), float(y)] for x, y, *_ in piece.coords]
                    if len(coordinates) < 2:
                        continue
                    feature_map[tile].append(
                        {
                            "type": "Feature",
                            "properties": properties,
                            "geometry": {
                                "type": "LineString",
                                "coordinates": coordinates,
                            },
                        }
                    )
                    way_ids[tile].add(way_id)
                    coordinate_totals[tile] += len(coordinates)
                    actual_bounds[tile].append(piece.bounds)

    split_seconds = 0.0
    metadata_by_tile: dict[tuple[float, float, float, float], dict[str, Any]] = {}
    for tile in tiles:
        features = feature_map[tile]
        bounds = actual_bounds[tile]
        actual_bbox = (
            [
                min(item[0] for item in bounds),
                min(item[1] for item in bounds),
                max(item[2] for item in bounds),
                max(item[3] for item in bounds),
            ]
            if bounds
            else None
        )
        metadata_by_tile[tile] = {
            "schema": "changwon-osm-road-tile-v1",
            "region": region_name,
            "source": "OpenStreetMap",
            "sourceDate": tile_builder.snapshot_date(input_path),
            "processedBounds": list(tile),
            "actualBounds": actual_bbox,
            "roadFeatureCount": len(features),
            "uniqueWayCount": len(way_ids[tile]),
            "coordinateCount": coordinate_totals[tile],
            "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "processingSeconds": round(network_seconds / max(1, len(tiles)), 3),
            "batchReadCount": 1,
        }
    collections = {
        tile: {
            "type": "FeatureCollection",
            "bbox": metadata_by_tile[tile]["actualBounds"],
            "meta": metadata_by_tile[tile],
            "features": feature_map[tile],
        }
        for tile in tiles
    }
    split_seconds = sum(
        metadata["processingSeconds"] for metadata in metadata_by_tile.values()
    )
    return collections, {"sourceWays": source_count, "splitSeconds": split_seconds}


def write_temp_tile(
    directory: Path, bbox: tuple[float, ...], collection: dict[str, Any]
) -> dict[str, Any]:
    data_path, marker_path = tile_builder.tile_paths(directory, bbox)
    with data_path.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(
            collection,
            output,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        )
        output.write("\n")
        output.flush()
        import os

        os.fsync(output.fileno())
    size = data_path.stat().st_size
    sha = tile_builder.sha256_file(data_path)
    metadata = collection["meta"]
    marker = {
        "complete": True,
        "tileId": tile_builder.tile_name(bbox),
        "file": data_path.name,
        "bbox": list(bbox),
        "roadFeatureCount": metadata["roadFeatureCount"],
        "uniqueWayCount": metadata["uniqueWayCount"],
        "coordinateCount": metadata["coordinateCount"],
        "sizeBytes": size,
        "sha256": sha,
        "generatedAt": metadata["generatedAt"],
    }
    marker_path.write_text(
        json.dumps(marker, ensure_ascii=False, separators=(",", ":")) + "\n",
        encoding="utf-8",
    )
    if tile_builder.validate_complete(data_path, marker_path, bbox) is None:
        raise ValueError(f"임시 타일 무결성 검증 실패: {data_path.name}")
    return marker


def feature_counter(collection: dict[str, Any]) -> Counter[str]:
    return Counter(
        canonical_feature(feature) for feature in collection.get("features", [])
    )


def main() -> int:
    args = parse_args()
    input_path = args.input.expanduser().resolve()
    batch_bbox = tuple(args.batch_bbox)
    output_dir = args.output_dir.expanduser().resolve()
    benchmark = args.benchmark_only
    if not input_path.is_file():
        print(f"[오류] 입력 PBF 파일이 없습니다: {input_path}", flush=True)
        return 1
    if len(batch_bbox) != 4 or not all(math.isfinite(value) for value in batch_bbox):
        print("[오류] --batch-bbox 값이 올바르지 않습니다.", flush=True)
        return 1

    log(f"batch_bbox={list(batch_bbox)} input={input_path}")
    log("PBF 도로망을 이 경계에서 한 번만 읽습니다. 전국 처리는 하지 않습니다.")
    start = time.perf_counter()
    output_context = None
    try:
        from pyrosm import OSM
        from shapely.geometry import box

        def pbf_progress(done: int, total: int) -> None:
            if total:
                log(f"PBF 진행 {int(done * 100 / total)}%")

        boundary = tile_builder.load_city_boundary(
            input_path,
            args.boundary_cache.expanduser().resolve(),
            log,
            pbf_progress,
        )
        batch_polygon = box(*batch_bbox)
        clip_region = boundary.intersection(batch_polygon)
        if clip_region.is_empty or clip_region.area <= 0:
            raise ValueError("배치 경계가 창원시 행정경계와 겹치지 않습니다.")
        tiles = grid_tiles(batch_bbox, boundary, args.tile_size_degrees)
        if not tiles:
            raise ValueError("배치 범위에서 창원시 격자 타일을 찾지 못했습니다.")
        log(f"타일 수={len(tiles)} tile_size={args.tile_size_degrees}")

        existing = {}
        for tile in tiles:
            data_path, marker_path = tile_builder.tile_paths(output_dir, tile)
            marker = tile_builder.validate_complete(data_path, marker_path, tile)
            if marker is not None:
                existing[tile] = json.loads(data_path.read_text(encoding="utf-8"))
            elif marker_path.exists():
                raise ValueError(
                    f"잘못된 완료 표식은 덮어쓰거나 완료 처리하지 않습니다: {marker_path}"
                )
            elif data_path.exists():
                log(f"완료 표식이 없는 미완료 타일은 재생성 후보: {data_path.name}")
        log(
            f"기존 완료 타일 재사용={len(existing)} · 새 타일 후보={len(tiles) - len(existing)}"
        )

        pbf_started = time.perf_counter()
        osm = OSM(
            str(input_path),
            bounding_box=list(batch_bbox),
            engine="out_of_core",
            workers=1,
            progress=pbf_progress,
        )
        roads = osm.get_network(
            network_type="walking", nodes=False, tags_to_keep=TAGS_TO_KEEP
        )
        network_seconds = time.perf_counter() - pbf_started
        log(
            f"PBF_READS=1 network_seconds={network_seconds:.2f} source_ways={len(roads) if roads is not None else 0}"
        )

        partition_started = time.perf_counter()
        collections, counts = build_collections(
            roads, boundary, batch_bbox, tiles, input_path, network_seconds
        )
        partition_seconds = time.perf_counter() - partition_started
        amortized = round((network_seconds + partition_seconds) / max(1, len(tiles)), 3)
        for collection in collections.values():
            collection["meta"]["processingSeconds"] = amortized
        log(
            f"partition_seconds={partition_seconds:.2f} source_ways={counts['sourceWays']}"
        )

        output_context = tempfile.TemporaryDirectory(
            prefix="changwon-road-batch-candidate-"
        )
        output_root = Path(output_context.name) / "tiles"
        output_root.mkdir(parents=True, exist_ok=True)
        from collections import Counter as CounterType

        batch_matches = []
        written = []
        for tile in tiles:
            collection = collections[tile]
            marker = write_temp_tile(output_root, tile, collection)
            old = existing.get(tile)
            if old is not None:
                old_counter = feature_counter(old)
                new_counter = feature_counter(collection)
                matches = sum((old_counter & new_counter).values())
                old_total, new_total = len(old["features"]), len(collection["features"])
                batch_matches.append(
                    {
                        "tileId": tile_builder.tile_name(tile),
                        "old": old_total,
                        "new": new_total,
                        "matched": matches,
                    }
                )
            written.append(marker)
            log(
                f"CANDIDATE {marker['tileId']} roads={marker['roadFeatureCount']} "
                f"coords={marker['coordinateCount']} bytes={marker['sizeBytes']} sha256={marker['sha256']}"
            )

        mismatches = [
            match
            for match in batch_matches
            if match["old"] != match["new"] or match["matched"] != match["old"]
        ]

        if benchmark:
            log("BENCHMARK_ONLY=true; 기존 타일·manifest는 수정하지 않았습니다.")
            log(
                f"temporary_output_tiles={len(written)} temporary_bytes={sum(marker['sizeBytes'] for marker in written)}"
            )
            for match in batch_matches:
                log(
                    f"COMPARE {match['tileId']} existing={match['old']} batch={match['new']} matched={match['matched']}"
                )
            if mismatches:
                log(f"[BENCHMARK_MISMATCH] {len(mismatches)} tile feature sets differ")
                output_context.cleanup()
                return 2
        else:
            if mismatches:
                raise ValueError(
                    f"완료 타일과 배치 추출 선형이 다릅니다: {[m['tileId'] for m in mismatches]}"
                )
            output_dir.mkdir(parents=True, exist_ok=True)
            base_data, base_marker_path = tile_builder.tile_paths(
                output_dir, tile_builder.BASE_BBOX
            )
            base_marker = tile_builder.validate_complete(
                base_data, base_marker_path, tile_builder.BASE_BBOX
            )
            if base_marker is None:
                raise ValueError("기준 타일의 완료 표식/SHA 검증 실패")
            for tile, marker in zip(tiles, written):
                if tile in existing:
                    continue
                data_path, marker_path = tile_builder.tile_paths(output_dir, tile)
                if marker_path.exists():
                    raise FileExistsError(
                        f"배치 실행 중 완료 표식이 생겨 덮어쓰지 않습니다: {marker_path}"
                    )
                source = output_root / data_path.name
                source_marker = output_root / marker_path.name
                temp_data = data_path.with_name(f".{data_path.name}.{os.getpid()}.part")
                temp_marker = marker_path.with_name(
                    f".{marker_path.name}.{os.getpid()}.part"
                )
                temp_data.write_bytes(source.read_bytes())
                temp_marker.write_bytes(source_marker.read_bytes())
                if tile_builder.validate_complete(temp_data, temp_marker, tile) is None:
                    raise ValueError(f"임시 타일 검증 실패: {data_path.name}")
                if data_path.exists():
                    log(
                        f"미완료 data-only 파일을 검증된 타일로 교체합니다: {data_path.name}"
                    )
                os.replace(temp_data, data_path)
                os.replace(temp_marker, marker_path)
                tile_builder.write_manifest(
                    args.manifest.expanduser().resolve(),
                    output_dir,
                    base_marker,
                    [
                        bbox
                        for bbox in all_city_tiles(boundary, args.tile_size_degrees)
                        if bbox != tile_builder.BASE_BBOX
                    ],
                )
                log(
                    f"TILE_COMPLETE {marker['tileId']} roads={marker['roadFeatureCount']} sha256={marker['sha256']}"
                )

        total_roads = sum(
            len(collection["features"]) for collection in collections.values()
        )
        total_coordinates = sum(
            collection["meta"]["coordinateCount"] for collection in collections.values()
        )
        old_seconds = sum(
            tile_builder_elapsed(tile_builder.tile_paths(output_dir, tile)[0])
            for tile in tiles
            if tile in existing
        )
        log(
            f"BATCH_SUMMARY tiles={len(tiles)} roads={total_roads} coords={total_coordinates}"
        )
        log(
            f"OLD_TILE_SECONDS_SUM={old_seconds:.2f} NEW_BATCH_SECONDS={time.perf_counter() - start:.2f} PBF_READS=1"
        )
        return 0
    except Exception as error:
        log(f"[BATCH_ERROR] {type(error).__name__}: {error}")
        if args.debug:
            log(traceback.format_exc())
        return 1
    finally:
        if output_context is not None:
            output_context.cleanup()


def tile_builder_elapsed(data_path: Path) -> float:
    log_path = data_path.with_suffix(".log")
    if not log_path.is_file():
        return 0.0
    import re

    matches = re.findall(
        r"완료: elapsed=([0-9.]+)s", log_path.read_text(encoding="utf-8")
    )
    return float(matches[-1]) if matches else 0.0


def all_city_tiles(
    boundary: Any, size: float
) -> list[tuple[float, float, float, float]]:
    from shapely.geometry import box

    min_x, min_y, max_x, max_y = boundary.bounds
    origin_x, origin_y = tile_builder.BASE_BBOX[:2]
    c0 = math.floor((min_x - origin_x) / size)
    c1 = math.ceil((max_x - origin_x) / size) - 1
    r0 = math.floor((min_y - origin_y) / size)
    r1 = math.ceil((max_y - origin_y) / size) - 1
    output = []
    for row in range(r0, r1 + 1):
        for col in range(c0, c1 + 1):
            west = round(origin_x + col * size, 8)
            south = round(origin_y + row * size, 8)
            tile = (west, south, round(west + size, 8), round(south + size, 8))
            if boundary.intersection(box(*tile)).area > 0:
                output.append(tile)
    return output


if __name__ == "__main__":
    raise SystemExit(main())
