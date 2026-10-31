#!/usr/bin/env python3
"""Extract Changwon walking roads into viewport-loadable GeoJSON tiles."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator


ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / "south-korea-261025.osm.pbf"
DEFAULT_OUTPUT = ROOT / "data" / "generated" / "changwon-city" / "tiles"
CITY_DATA_DIR = ROOT / "data" / "generated" / "changwon-city"
DEFAULT_BOUNDARY_CACHE = CITY_DATA_DIR / "cache" / "changwon-boundary.geojson"
DEFAULT_MANIFEST = CITY_DATA_DIR / "manifest.json"
BASE_BBOX = (128.66, 35.20, 128.70, 35.24)
OUTER_TILE_BBOXES = [
    (128.58, 35.20, 128.62, 35.24),
    (128.74, 35.20, 128.78, 35.24),
    (128.66, 35.12, 128.70, 35.16),
    (128.66, 35.28, 128.70, 35.32),
]
TAGS_TO_KEEP = ["access", "foot", "footway", "highway", "name", "surface"]


def progress(message: str) -> None:
    print(message, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="창원시 경계 캐시를 재사용하며 지정한 소수 타일만 처리합니다."
    )
    parser.add_argument(
        "--input", type=Path, default=DEFAULT_INPUT, help="입력 OSM PBF 경로"
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--tile-bbox",
        type=float,
        nargs=4,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="단일 타일 처리 모드의 경계 (경도·위도)",
    )
    group.add_argument(
        "--neighbors-of",
        type=float,
        nargs=4,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="기준 타일의 서·동·남·북 인접 타일 4개만 처리",
    )
    group.add_argument(
        "--diagonals-of",
        type=float,
        nargs=4,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="기준 타일의 북서·북동·남서·남동 타일 4개만 처리",
    )
    group.add_argument(
        "--batch-tile-bbox",
        type=float,
        nargs=4,
        action="append",
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        help="명시한 타일만 배치 처리 (타일마다 한 번씩 반복)",
    )
    group.add_argument(
        "--tile-list",
        type=Path,
        help="plan_changwon_tiles.py가 만든 남은 타일 JSON 목록",
    )
    parser.add_argument(
        "--limit",
        type=int,
        choices=(1, 2, 3, 4, 5, 6),
        default=5,
        help="--tile-list에서 이번 실행에 처리할 최대 타일 수 (1~6, 기본 5)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="타일·완료 표식·로그를 저장할 폴더",
    )
    parser.add_argument(
        "--boundary-cache",
        type=Path,
        default=DEFAULT_BOUNDARY_CACHE,
        help="창원시 행정경계 GeoJSON 캐시",
    )
    parser.add_argument(
        "--region-name", default="창원시", help="단일 타일 모드 행정경계 이름"
    )
    parser.add_argument(
        "--admin-level", default="6", help="단일 타일 모드 행정경계 수준"
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=DEFAULT_MANIFEST,
        help="완료된 인접 타일 목록",
    )
    parser.add_argument(
        "--debug", action="store_true", help="오류 시 전체 traceback 표시"
    )
    return parser.parse_args()


def snapshot_date(path: Path) -> str:
    match = re.search(r"(\d{6})(?=\.osm\.pbf$)", path.name)
    if not match:
        return "unknown"
    try:
        return datetime.strptime(match.group(1), "%y%m%d").date().isoformat()
    except ValueError:
        return "unknown"


def value(row: Any, key: str) -> str:
    item = row.get(key)
    if item is None:
        return ""
    if isinstance(item, float) and math.isnan(item):
        return ""
    item = str(item).strip()
    return "" if item.lower() in {"nan", "none", "<na>"} else item


def line_parts(geometry: Any) -> Iterator[Any]:
    if geometry is None or geometry.is_empty:
        return
    kind = geometry.geom_type
    if kind == "LineString":
        if geometry.length > 0:
            yield geometry
    elif kind in {"MultiLineString", "GeometryCollection"}:
        for child in geometry.geoms:
            yield from line_parts(child)


def tile_name(bbox: tuple[float, ...]) -> str:
    return "tile_" + "_".join(str(round(value * 10_000)) for value in bbox)


def coordinate_count(coordinates: Any) -> int:
    if not isinstance(coordinates, (list, tuple)) or not coordinates:
        return 0
    if isinstance(coordinates[0], (int, float)):
        return 1
    return sum(coordinate_count(child) for child in coordinates)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_complete(
    data_path: Path, marker_path: Path, bbox: tuple[float, ...]
) -> dict[str, Any] | None:
    if not data_path.is_file() or not marker_path.is_file():
        return None
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    if marker.get("complete") is not True or marker.get("bbox") != list(bbox):
        return None
    if marker.get("sizeBytes") != data_path.stat().st_size or marker.get(
        "sha256"
    ) != sha256_file(data_path):
        return None
    collection = json.loads(data_path.read_text(encoding="utf-8"))
    features = collection.get("features")
    meta = collection.get("meta")
    if (
        collection.get("type") != "FeatureCollection"
        or not isinstance(features, list)
        or not isinstance(meta, dict)
    ):
        return None
    if meta.get("processedBounds") != list(bbox) or meta.get("roadFeatureCount") != len(
        features
    ):
        return None
    if meta.get("coordinateCount") != sum(
        coordinate_count(feature.get("geometry", {}).get("coordinates"))
        for feature in features
    ):
        return None
    return marker


def neighbor_bboxes(
    base: tuple[float, float, float, float],
) -> list[tuple[float, float, float, float]]:
    west, south, east, north = base
    width, height = east - west, north - south
    return [
        (round(west - width, 8), round(south, 8), round(west, 8), round(north, 8)),
        (round(east, 8), round(south, 8), round(east + width, 8), round(north, 8)),
        (round(west, 8), round(south - height, 8), round(east, 8), round(south, 8)),
        (round(west, 8), round(north, 8), round(east, 8), round(north + height, 8)),
    ]


def diagonal_bboxes(
    base: tuple[float, float, float, float],
) -> list[tuple[float, float, float, float]]:
    west, south, east, north = base
    width, height = east - west, north - south
    return [
        (
            round(west - width, 8),
            round(north, 8),
            round(west, 8),
            round(north + height, 8),
        ),
        (
            round(east, 8),
            round(north, 8),
            round(east + width, 8),
            round(north + height, 8),
        ),
        (
            round(west - width, 8),
            round(south - height, 8),
            round(west, 8),
            round(south, 8),
        ),
        (
            round(east, 8),
            round(south - height, 8),
            round(east + width, 8),
            round(south, 8),
        ),
    ]


def all_extension_bboxes() -> list[tuple[float, float, float, float]]:
    return neighbor_bboxes(BASE_BBOX) + diagonal_bboxes(BASE_BBOX) + OUTER_TILE_BBOXES


def tile_paths(output_dir: Path, bbox: tuple[float, ...]) -> tuple[Path, Path]:
    name = tile_name(bbox)
    return output_dir / f"{name}.geojson", output_dir / f"{name}.complete.json"


def load_city_boundary(
    input_path: Path,
    cache_path: Path,
    log: Any,
    report_read: Any,
    region_name: str = "창원시",
    admin_level: str = "6",
) -> Any:
    from shapely.geometry import shape, mapping
    from pyrosm import OSM

    marker_path = cache_path.with_suffix(".complete.json")
    if cache_path.exists() or marker_path.exists():
        try:
            if not cache_path.is_file() or not marker_path.is_file():
                raise ValueError("캐시 GeoJSON 또는 완료 표식이 없습니다.")
            marker = json.loads(marker_path.read_text(encoding="utf-8"))
            if (
                marker.get("complete") is not True
                or marker.get("name") != region_name
                or marker.get("adminLevel") != admin_level
                or marker.get("sizeBytes") != cache_path.stat().st_size
                or marker.get("sha256") != sha256_file(cache_path)
            ):
                raise ValueError(
                    "캐시 완료 표식, 크기 또는 SHA-256이 일치하지 않습니다."
                )
            cached = json.loads(cache_path.read_text(encoding="utf-8"))
            feature = cached["features"][0]
            boundary = shape(feature["geometry"])
            if (
                cached.get("type") != "FeatureCollection"
                or feature["properties"].get("name") != region_name
                or feature["properties"].get("admin_level") != admin_level
                or boundary.is_empty
                or not boundary.is_valid
                or list(boundary.bounds) != marker.get("bounds")
            ):
                raise ValueError(
                    f"캐시된 행정경계 도형 검증에 실패했습니다: {region_name}/{admin_level}"
                )
            log(f"[BOUNDARY_CACHE_HIT] {cache_path} sha256={marker['sha256']}")
            return boundary
        except Exception as error:
            log(
                f"[BOUNDARY_CACHE_ERROR] {type(error).__name__}: {error}; 로컬 PBF에서 다시 조회합니다."
            )
    else:
        log(f"[BOUNDARY_CACHE_MISS] {cache_path}")

    log(
        "[BOUNDARY_SOURCE] 외부 네트워크는 사용하지 않습니다. 로컬 PBF의 행정경계만 조회합니다."
    )
    try:
        boundary_reader = OSM(
            str(input_path), engine="out_of_core", workers=1, progress=report_read
        )
        boundaries = boundary_reader.get_boundaries(
            boundary_type="administrative", name=region_name
        )
        if boundaries is None or boundaries.empty or "geometry" not in boundaries:
            raise ValueError(f"PBF에서 행정경계를 찾지 못했습니다: {region_name}")
        matches = boundaries
        if "admin_level" in matches.columns:
            matches = matches[matches["admin_level"].astype(str) == admin_level]
        if matches.empty:
            raise ValueError(
                f"행정경계 중 admin_level={admin_level} 경계가 없습니다: {region_name}"
            )
        boundary = matches.geometry.union_all()
        if boundary.is_empty or not boundary.is_valid:
            raise ValueError(
                f"PBF 행정경계 도형이 비었거나 유효하지 않습니다: {region_name}"
            )
    except Exception as error:
        log(f"[BOUNDARY_PBF_ERROR] {type(error).__name__}: {error}")
        raise

    cache_path.parent.mkdir(parents=True, exist_ok=True)
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
            "source": "OpenStreetMap PBF",
            "sourceDate": snapshot_date(input_path),
            "generatedAt": generated_at,
        },
    }
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
    size_bytes = temp_cache.stat().st_size
    digest = sha256_file(temp_cache)
    marker = {
        "complete": True,
        "name": region_name,
        "adminLevel": admin_level,
        "bounds": list(boundary.bounds),
        "sizeBytes": size_bytes,
        "sha256": digest,
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
    log(
        f"[BOUNDARY_CACHE_SAVED] {cache_path} bounds={marker['bounds']} sha256={digest}"
    )
    return boundary


def write_manifest(
    manifest_path: Path,
    output_dir: Path,
    base_marker: dict[str, Any],
    neighbor_boxes: list[tuple[float, float, float, float]],
) -> dict[str, Any]:
    entries = []
    for bbox in neighbor_boxes:
        data_path, marker_path = tile_paths(output_dir, bbox)
        marker = validate_complete(data_path, marker_path, bbox)
        if marker is None:
            continue
        entries.append(
            {
                "id": marker["tileId"],
                "file": f"tiles/{data_path.name}",
                "bbox": marker["bbox"],
                "featureCount": marker["roadFeatureCount"],
                "coordinateCount": marker["coordinateCount"],
                "bytes": marker["sizeBytes"],
                "sha256": marker["sha256"],
                "generatedAt": marker["generatedAt"],
            }
        )
    if entries:
        available_bounds = [
            min(tile["bbox"][0] for tile in entries),
            min(tile["bbox"][1] for tile in entries),
            max(tile["bbox"][2] for tile in entries),
            max(tile["bbox"][3] for tile in entries),
        ]
    else:
        available_bounds = None
    base_entry = {
        "id": base_marker["tileId"],
        "bbox": base_marker["bbox"],
        "featureCount": base_marker["roadFeatureCount"],
        "coordinateCount": base_marker["coordinateCount"],
        "sha256": base_marker["sha256"],
    }
    manifest = {
        "schema": "changwon-osm-road-tiles-v1",
        "region": "창원시 일부 시험 타일",
        "source": "OpenStreetMap",
        "attribution": "© OpenStreetMap contributors",
        "baseTile": base_entry,
        "expectedNeighborTileCount": len(neighbor_boxes),
        "completeNeighborTileCount": len(entries),
        "availableBounds": available_bounds,
        "tiles": entries,
        "updatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "coverageNote": "이 manifest는 완료된 인접 시험 타일만 나열하며 창원시 전체 범위가 아닙니다.",
    }
    if not entries:
        return manifest
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = manifest_path.with_name(f".{manifest_path.name}.{os.getpid()}.part")
    with temporary.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(
            manifest, output, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, manifest_path)
    return manifest


def process_single_tile(args: argparse.Namespace) -> int:
    log_file = None

    def log(message: str) -> None:
        line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {message}"
        print(line, flush=True)
        if log_file is not None:
            log_file.write(line + "\n")
            log_file.flush()

    try:
        input_path = args.input.expanduser().resolve()
        output_dir = args.output_dir.expanduser().resolve()
        boundary_cache_path = args.boundary_cache.expanduser().resolve()
        if args.tile_bbox is None:
            raise ValueError("단일 타일 처리에는 --tile-bbox가 필요합니다.")
        bbox = tuple(args.tile_bbox)
        if len(bbox) != 4 or not all(math.isfinite(value) for value in bbox):
            raise ValueError("--tile-bbox에는 유한한 숫자 4개가 필요합니다.")
        west, south, east, north = bbox
        if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
            raise ValueError("타일 경계 순서 또는 좌표 범위가 올바르지 않습니다.")
        if not input_path.is_file():
            raise FileNotFoundError(f"입력 PBF 파일이 없습니다: {input_path}")
        if (
            output_dir == (ROOT / "data.json").resolve()
            or output_dir.name.lower() == "data.json"
        ):
            raise ValueError(
                "기존 data.json 보호를 위해 해당 경로는 사용할 수 없습니다."
            )

        name = tile_name(bbox)
        data_path = output_dir / f"{name}.geojson"
        marker_path = output_dir / f"{name}.complete.json"
        log_path = output_dir / f"{name}.log"
        output_dir.mkdir(parents=True, exist_ok=True)
        log_file = log_path.open("a", encoding="utf-8")
        started = time.perf_counter()
        log(f"tile={name} bbox={list(bbox)} input={input_path} output={data_path}")

        if marker_path.exists():
            marker = validate_complete(data_path, marker_path, bbox)
            if marker is None:
                raise ValueError(
                    f"완료 표식과 타일 파일 검증이 맞지 않습니다. 재사용하지 않습니다: {marker_path}"
                )
            log(
                f"검증된 완료 타일 재사용: roads={marker['roadFeatureCount']} coords={marker['coordinateCount']} sha256={marker['sha256']}"
            )
            return 0
        if data_path.exists():
            log(
                "완료 표식이 없는 기존 타일 파일은 완료 결과로 간주하지 않습니다. 새 결과 검증 전까지 재사용하지 않습니다."
            )

        try:
            from pyrosm import OSM
            from shapely.geometry import box
        except ImportError as error:
            raise RuntimeError(
                "pyrosm과 shapely가 필요합니다. `python -m pip install pyrosm`으로 설치하세요."
            ) from error

        read_percent = [-10]

        def report_read(done: int, total: int) -> None:
            if total <= 0:
                return
            percent = int(done * 100 / total)
            if percent >= read_percent[0] + 10 or percent == 100:
                log(f"PBF 읽기 {percent}%")
                read_percent[0] = percent

        log(f"[1/5] {args.region_name} 행정경계 캐시를 확인합니다.")
        phase_started = time.perf_counter()
        city_boundary = load_city_boundary(
            input_path,
            boundary_cache_path,
            log,
            report_read,
            args.region_name,
            args.admin_level,
        )
        tile_polygon = box(*bbox)
        clip_polygon = tile_polygon.intersection(city_boundary)
        if clip_polygon.is_empty or clip_polygon.area <= 0:
            raise ValueError(
                f"지정한 타일과 {args.region_name} 행정경계가 겹치지 않습니다."
            )
        log(
            f"경계 캐시 확인 완료: {time.perf_counter() - phase_started:.2f}s tile_clip_bounds={clip_polygon.bounds}"
        )

        log(
            "[2/5] 타일 경계를 PBF 리더에 전달합니다. 전국 road network는 생성하지 않습니다."
        )
        read_percent[0] = -10
        osm = OSM(
            str(input_path),
            bounding_box=list(bbox),
            engine="out_of_core",
            workers=1,
            progress=report_read,
        )
        log(f"[3/5] 단일 타일 보행 도로 읽기 시작: {list(bbox)}")
        phase_started = time.perf_counter()
        roads = osm.get_network(
            network_type="walking", nodes=False, tags_to_keep=TAGS_TO_KEEP
        )
        if roads is None:
            source_way_count = 0
            road_rows = ()
            log(
                "Pyrosm이 이 타일에서 보행 간선을 찾지 못했습니다. 경계 검증된 빈 타일로 기록합니다."
            )
        else:
            if "geometry" not in roads.columns or "id" not in roads.columns:
                raise ValueError("Pyrosm 결과에 geometry 또는 OSM id가 없습니다.")
            source_way_count = len(roads)
            road_rows = roads.iterrows()
        log(
            f"PBF 타일 읽기 완료: {time.perf_counter() - phase_started:.2f}s source_ways={source_way_count:,}"
        )

        log("[4/5] 타일 경계 안의 도로 좌표를 구성합니다.")
        phase_started = time.perf_counter()
        features: list[dict[str, Any]] = []
        way_ids: set[str] = set()
        actual_bounds: list[tuple[float, float, float, float]] = []
        coord_count = 0
        for _, row in road_rows:
            geometry = row.get("geometry")
            if geometry is None or geometry.is_empty:
                continue
            clipped = geometry.intersection(clip_polygon)
            way_id = value(row, "id")
            if clipped.is_empty or not way_id:
                continue
            for line in line_parts(clipped):
                coordinates = [[float(x), float(y)] for x, y, *_ in line.coords]
                if len(coordinates) < 2:
                    continue
                features.append(
                    {
                        "type": "Feature",
                        "properties": {
                            "osmId": f"way/{way_id}",
                            "highway": value(row, "highway"),
                            "name": value(row, "name"),
                            "surface": value(row, "surface"),
                        },
                        "geometry": {"type": "LineString", "coordinates": coordinates},
                    }
                )
                way_ids.add(way_id)
                coord_count += len(coordinates)
                actual_bounds.append(line.bounds)
        actual_bbox = (
            [
                min(bounds[0] for bounds in actual_bounds),
                min(bounds[1] for bounds in actual_bounds),
                max(bounds[2] for bounds in actual_bounds),
                max(bounds[3] for bounds in actual_bounds),
            ]
            if actual_bounds
            else None
        )
        if not features:
            log(
                f"{args.region_name} 경계와 교차하는 보행 도로선이 없어 빈 GeoJSON 타일로 완료 기록합니다."
            )
        generated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        metadata = {
            "schema": "changwon-osm-road-tile-v1",
            "region": args.region_name,
            "source": "OpenStreetMap",
            "sourceDate": snapshot_date(input_path),
            "processedBounds": list(bbox),
            "actualBounds": actual_bbox,
            "roadFeatureCount": len(features),
            "uniqueWayCount": len(way_ids),
            "coordinateCount": coord_count,
            "generatedAt": generated_at,
            "processingSeconds": round(time.perf_counter() - started, 3),
        }
        collection = {
            "type": "FeatureCollection",
            "bbox": actual_bbox,
            "meta": metadata,
            "features": features,
        }
        if len(features) != metadata["roadFeatureCount"] or coord_count != sum(
            coordinate_count(feature["geometry"]["coordinates"]) for feature in features
        ):
            raise ValueError("GeoJSON 생성 후 도로·좌표 개수 검증이 맞지 않습니다.")
        if any(
            not (
                west - 1e-9 <= lon <= east + 1e-9
                and south - 1e-9 <= lat <= north + 1e-9
            )
            for feature in features
            for lon, lat in feature["geometry"]["coordinates"]
        ):
            raise ValueError("타일 경계 바깥 좌표가 발견되어 저장을 중단합니다.")
        log(
            f"좌표 구성 완료: {time.perf_counter() - phase_started:.2f}s roads={len(features):,} ways={len(way_ids):,} coords={coord_count:,} bounds={actual_bbox}"
        )

        log("[5/5] 임시 GeoJSON을 검증한 뒤 타일과 완료 표식을 저장합니다.")
        temp_data = output_dir / f".{name}.{os.getpid()}.part"
        temp_marker = output_dir / f".{name}.{os.getpid()}.complete.part"
        with temp_data.open("x", encoding="utf-8", newline="\n") as destination:
            json.dump(
                collection,
                destination,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        checked = json.loads(temp_data.read_text(encoding="utf-8"))
        if checked.get("type") != "FeatureCollection" or len(
            checked.get("features", [])
        ) != len(features):
            raise ValueError("임시 GeoJSON 다시 읽기 검증에 실패했습니다.")
        digest = sha256_file(temp_data)
        size_bytes = temp_data.stat().st_size
        os.replace(temp_data, data_path)
        marker = {
            "complete": True,
            "tileId": name,
            "file": data_path.name,
            "bbox": list(bbox),
            "roadFeatureCount": len(features),
            "uniqueWayCount": len(way_ids),
            "coordinateCount": coord_count,
            "sizeBytes": size_bytes,
            "sha256": digest,
            "generatedAt": generated_at,
        }
        with temp_marker.open("x", encoding="utf-8", newline="\n") as destination:
            json.dump(
                marker,
                destination,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            destination.write("\n")
            destination.flush()
            os.fsync(destination.fileno())
        os.replace(temp_marker, marker_path)
        log(
            f"완료: elapsed={time.perf_counter() - started:.2f}s roads={len(features):,} coords={coord_count:,} bytes={size_bytes:,}"
        )
        log(f"DATA={data_path}")
        log(f"COMPLETE={marker_path}")
        log(f"LOG={log_path}")
        return 0
    except Exception as error:
        log(f"[오류] {type(error).__name__}: {error}")
        if args.debug:
            details = traceback.format_exc()
            log(details)
        return 1
    finally:
        if log_file is not None:
            log_file.close()


def run_neighbor_batch(args: argparse.Namespace) -> int:
    input_path = args.input.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    boundary_cache = args.boundary_cache.expanduser().resolve()
    manifest_path = args.manifest.expanduser().resolve()
    explicit_mode = args.batch_tile_bbox is not None
    diagonal_mode = args.diagonals_of is not None
    batch_name = (
        "outer-tiles"
        if explicit_mode
        else "diagonal-tiles"
        if diagonal_mode
        else "neighbor-tiles"
    )
    batch_log_path = manifest_path.with_name(f"{batch_name}.log")
    log_file = None

    def log(message: str) -> None:
        line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {message}"
        print(line, flush=True)
        if log_file is not None:
            log_file.write(line + "\n")
            log_file.flush()

    try:
        if not input_path.is_file():
            raise FileNotFoundError(f"입력 PBF 파일이 없습니다: {input_path}")
        requested_base = (
            BASE_BBOX
            if explicit_mode
            else args.diagonals_of
            if diagonal_mode
            else args.neighbors_of
        )
        if requested_base is None:
            raise ValueError(
                "인접 타일 4개 처리에는 --neighbors-of 또는 --diagonals-of가 필요합니다."
            )
        base_bbox = tuple(requested_base)
        if len(base_bbox) != 4 or any(
            abs(a - b) > 1e-9 for a, b in zip(base_bbox, BASE_BBOX)
        ):
            raise ValueError(
                f"이번 배치는 검증된 기준 타일 {BASE_BBOX}의 인접 타일만 처리합니다."
            )
        output_dir.mkdir(parents=True, exist_ok=True)
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        log_file = batch_log_path.open("a", encoding="utf-8")
        log(f"[0/4] 기준 타일 검증: bbox={list(BASE_BBOX)}")
        base_data, base_marker_path = tile_paths(output_dir, BASE_BBOX)
        base_marker = validate_complete(base_data, base_marker_path, BASE_BBOX)
        if base_marker is None:
            raise ValueError(
                f"기존 성공 타일의 완료 표식 또는 SHA-256 검증 실패: {base_marker_path}"
            )
        log(
            f"[0/4] 기준 타일 재사용: roads={base_marker['roadFeatureCount']} coords={base_marker['coordinateCount']} sha256={base_marker['sha256']}"
        )

        selected_tiles = (
            [
                (float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]))
                for bbox in args.batch_tile_bbox
            ]
            if explicit_mode
            else diagonal_bboxes(BASE_BBOX)
            if diagonal_mode
            else neighbor_bboxes(BASE_BBOX)
        )
        all_tiles = all_extension_bboxes()
        if len(selected_tiles) != 4 or len(set(selected_tiles)) != 4:
            raise ValueError(
                "기준 타일로부터 서로 다른 선택 타일 4개를 만들지 못했습니다."
            )
        if explicit_mode and set(selected_tiles) != set(OUTER_TILE_BBOXES):
            raise ValueError(
                "이번 추가 배치는 요청된 동·서·남·북 외곽 타일 4개만 허용합니다."
            )
        for bbox in neighbor_bboxes(BASE_BBOX):
            data_path, marker_path = tile_paths(output_dir, bbox)
            marker = validate_complete(data_path, marker_path, bbox)
            if marker is None:
                raise ValueError(f"기존 네 인접 타일 검증 실패: {marker_path}")
        precompleted: dict[tuple[float, ...], dict[str, Any]] = {}
        for bbox in selected_tiles:
            data_path, marker_path = tile_paths(output_dir, bbox)
            if marker_path.exists():
                marker = validate_complete(data_path, marker_path, bbox)
                if marker is None:
                    raise ValueError(
                        f"기존 인접 타일의 완료 표식 또는 SHA-256 검증 실패: {marker_path}"
                    )
                precompleted[bbox] = marker
                log(f"[재사용] {marker['tileId']} sha256={marker['sha256']}")
        for bbox in all_tiles:
            data_path, marker_path = tile_paths(output_dir, bbox)
            if (
                marker_path.exists()
                and validate_complete(data_path, marker_path, bbox) is None
            ):
                raise ValueError(
                    f"기존 확장 타일의 완료 표식 또는 SHA-256 검증 실패: {marker_path}"
                )
        write_manifest(manifest_path, output_dir, base_marker, all_tiles)

        pending = [bbox for bbox in selected_tiles if bbox not in precompleted]
        if pending:
            from shapely.geometry import box

            read_percent = [-10]

            def report_boundary_read(done: int, total: int) -> None:
                if total <= 0:
                    return
                percent = int(done * 100 / total)
                if percent >= read_percent[0] + 10 or percent == 100:
                    log(f"경계 조회 PBF 진행 {percent}%")
                    read_percent[0] = percent

            log(f"경계 캐시 조회: {boundary_cache}")
            city_boundary = load_city_boundary(
                input_path, boundary_cache, log, report_boundary_read
            )
            intersections = [
                city_boundary.intersection(box(*bbox)) for bbox in selected_tiles
            ]
            outside = [
                bbox
                for bbox, intersection in zip(selected_tiles, intersections)
                if intersection.is_empty or intersection.area <= 0
            ]
            if outside:
                raise ValueError(
                    f"창원시 행정경계와 겹치지 않는 인접 타일이 있습니다: {outside}"
                )
            partial_count = sum(
                not city_boundary.covers(box(*bbox)) for bbox in selected_tiles
            )
            log(
                f"선택 타일 4개의 경계 교차 확인 완료: 부분 교차 {partial_count}개는 행정경계로 잘립니다."
            )

        failures = []
        for index, bbox in enumerate(selected_tiles, start=1):
            if bbox in precompleted:
                log(f"[{index}/4] 완료 타일 건너뜀: {tile_name(bbox)}")
                continue
            log(f"[{index}/4] 타일 처리 시작: {tile_name(bbox)} bbox={list(bbox)}")
            command = [
                sys.executable,
                str(Path(__file__).resolve()),
                "--input",
                str(input_path),
                "--tile-bbox",
                *[format(value, ".10g") for value in bbox],
                "--output-dir",
                str(output_dir),
                "--boundary-cache",
                str(boundary_cache),
                "--manifest",
                str(manifest_path),
            ]
            if args.debug:
                command.append("--debug")
            try:
                result = subprocess.run(command, check=False, timeout=180)
            except subprocess.TimeoutExpired:
                result = None
                log(f"[타일 시간 초과] {tile_name(bbox)}: 180초")
            if result is None or result.returncode != 0:
                failures.append(tile_name(bbox))
                log(f"[타일 실패] {tile_name(bbox)}; 완료된 이전 타일은 유지됩니다.")
            else:
                data_path, marker_path = tile_paths(output_dir, bbox)
                marker = validate_complete(data_path, marker_path, bbox)
                if marker is None:
                    failures.append(tile_name(bbox))
                    log(
                        f"[완료 검증 실패] {tile_name(bbox)}; manifest에 추가하지 않습니다."
                    )
                else:
                    log(
                        f"[{index}/4] 검증 완료: roads={marker['roadFeatureCount']} coords={marker['coordinateCount']} sha256={marker['sha256']}"
                    )
            write_manifest(manifest_path, output_dir, base_marker, all_tiles)

        complete_count = sum(
            validate_complete(*tile_paths(output_dir, bbox), bbox) is not None
            for bbox in selected_tiles
        )
        log(
            f"{batch_name} 배치 종료: 선택 타일 완료 {complete_count}/4 · 실패 {len(failures)} · manifest={manifest_path}"
        )
        return 0 if complete_count == 4 and not failures else 1
    except Exception as error:
        log(f"[배치 오류] {type(error).__name__}: {error}")
        if args.debug:
            log(traceback.format_exc())
        return 1
    finally:
        if log_file is not None:
            log_file.close()


def run_tile_list_batch(args: argparse.Namespace) -> int:
    input_path = args.input.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()
    boundary_cache = args.boundary_cache.expanduser().resolve()
    plan_path = args.tile_list.expanduser().resolve()
    batch_log_path = CITY_DATA_DIR / "remaining-tile-batch.log"
    log_file = None

    def log(message: str) -> None:
        line = f"{datetime.now(timezone.utc).isoformat(timespec='seconds')} {message}"
        print(line, flush=True)
        if log_file is not None:
            log_file.write(line + "\n")
            log_file.flush()

    try:
        if not input_path.is_file():
            raise FileNotFoundError(f"입력 PBF 파일이 없습니다: {input_path}")
        if not plan_path.is_file():
            raise FileNotFoundError(f"타일 목록 파일이 없습니다: {plan_path}")
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        if plan.get("schema") != "changwon-remaining-tile-plan-v1":
            raise ValueError("지원하지 않는 tile-list JSON 형식입니다.")
        if not isinstance(plan.get("allTileBBoxes"), list) or not isinstance(
            plan.get("remainingTileBBoxes"), list
        ):
            raise ValueError(
                "tile-list JSON에 allTileBBoxes 또는 remainingTileBBoxes가 없습니다."
            )
        all_bboxes = [
            (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
            for box in plan["allTileBBoxes"]
        ]
        planned_remaining = [
            (float(box[0]), float(box[1]), float(box[2]), float(box[3]))
            for box in plan["remainingTileBBoxes"]
        ]
        if len(all_bboxes) != plan.get("totalTiles") or len(
            planned_remaining
        ) != plan.get("remainingTiles"):
            raise ValueError(
                "tile-list JSON의 타일 개수 정보가 내용과 일치하지 않습니다."
            )
        if len(set(all_bboxes)) != len(all_bboxes) or not set(
            planned_remaining
        ).issubset(set(all_bboxes)):
            raise ValueError(
                "tile-list JSON에 중복되거나 전체 목록에 없는 타일이 있습니다."
            )
        if BASE_BBOX not in all_bboxes:
            raise ValueError("tile-list JSON에 기준 타일이 없습니다.")
        if not 1 <= args.limit <= 6:
            raise ValueError("--limit은 1~6 범위여야 합니다.")

        output_dir.mkdir(parents=True, exist_ok=True)
        CITY_DATA_DIR.mkdir(parents=True, exist_ok=True)
        log_file = batch_log_path.open("a", encoding="utf-8")
        base_data, base_marker_path = tile_paths(output_dir, BASE_BBOX)
        base_marker = validate_complete(base_data, base_marker_path, BASE_BBOX)
        if base_marker is None:
            raise ValueError(
                f"기준 타일 완료 표식/SHA-256 검증 실패: {base_marker_path}"
            )

        cache_marker_path = boundary_cache.with_suffix(".complete.json")
        if not boundary_cache.is_file() or not cache_marker_path.is_file():
            raise FileNotFoundError("검증된 행정경계 캐시가 없습니다.")
        cache_marker = json.loads(cache_marker_path.read_text(encoding="utf-8"))
        if (
            cache_marker.get("complete") is not True
            or cache_marker.get("sha256") != plan.get("boundaryCacheSha256")
            or cache_marker.get("sha256") != sha256_file(boundary_cache)
        ):
            raise ValueError(
                "tile-list가 작성된 뒤 행정경계 캐시가 바뀌었거나 손상됐습니다."
            )

        manifest_path = args.manifest.expanduser().resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_bboxes = {
            tuple(float(value) for value in entry["bbox"])
            for entry in manifest.get("tiles", [])
            if isinstance(entry.get("bbox"), list) and len(entry["bbox"]) == 4
        }
        if not manifest_bboxes.issubset(set(all_bboxes)):
            raise ValueError("현재 manifest에 tile-list 범위 밖의 항목이 있습니다.")

        candidates = []
        first_batch = planned_remaining[: args.limit]
        for bbox in first_batch:
            data_path, marker_path = tile_paths(output_dir, bbox)
            if marker_path.exists():
                marker = validate_complete(data_path, marker_path, bbox)
                if marker is None:
                    raise ValueError(
                        f"미완료/손상 완료 표식은 재사용하지 않습니다: {marker_path}"
                    )
                log(
                    f"[재사용] 계획 이후 완료된 타일 건너뜀: {marker['tileId']} sha256={marker['sha256']}"
                )
                continue
            candidates.append(bbox)
        selected = candidates
        if not selected:
            log("계획에 남은 미완료 타일이 없습니다. 타일 추출은 수행하지 않습니다.")
            return 0

        from shapely.geometry import box

        read_percent = [-10]

        def report_boundary_read(done: int, total: int) -> None:
            if total <= 0:
                return
            percent = int(done * 100 / total)
            if percent >= read_percent[0] + 10 or percent == 100:
                log(f"경계 캐시 확인 진행 {percent}%")
                read_percent[0] = percent

        city_boundary = load_city_boundary(
            input_path, boundary_cache, log, report_boundary_read
        )
        outside = [
            bbox
            for bbox in selected
            if city_boundary.intersection(box(*bbox)).area <= 0
        ]
        if outside:
            raise ValueError(f"창원시 행정경계와 교차하지 않는 선택 타일: {outside}")

        all_extension_tiles = [bbox for bbox in all_bboxes if bbox != BASE_BBOX]
        existing_complete = sum(
            validate_complete(*tile_paths(output_dir, bbox), bbox) is not None
            for bbox in all_extension_tiles
        )
        log(
            f"계획 remaining={plan['remainingTiles']} · 현재 완료={existing_complete} "
            f"· 이번 선택={len(selected)}/{args.limit}"
        )
        write_manifest(manifest_path, output_dir, base_marker, all_extension_tiles)

        failures = []
        for index, bbox in enumerate(selected, start=1):
            log(
                f"[{index}/{len(selected)}] 계획 타일 시작: {tile_name(bbox)} bbox={list(bbox)}"
            )
            tile_args = argparse.Namespace(
                input=input_path,
                tile_bbox=list(bbox),
                output_dir=output_dir,
                boundary_cache=boundary_cache,
                debug=args.debug,
            )
            status = process_single_tile(tile_args)
            data_path, marker_path = tile_paths(output_dir, bbox)
            marker = validate_complete(data_path, marker_path, bbox)
            if status != 0 or marker is None:
                failures.append(tile_name(bbox))
                log(
                    f"[타일 실패] {tile_name(bbox)}; 앞서 완료한 타일과 manifest는 보존합니다."
                )
            else:
                log(
                    f"[{index}/{len(selected)}] 완료·검증: roads={marker['roadFeatureCount']} "
                    f"coords={marker['coordinateCount']} bytes={marker['sizeBytes']} sha256={marker['sha256']}"
                )
            write_manifest(manifest_path, output_dir, base_marker, all_extension_tiles)

        completed_batch = sum(
            validate_complete(*tile_paths(output_dir, bbox), bbox) is not None
            for bbox in selected
        )
        log(
            f"tile-list 배치 종료: 완료 {completed_batch}/{len(selected)} · "
            f"실패 {len(failures)} · manifest={manifest_path}"
        )
        return 0 if completed_batch == len(selected) and not failures else 1
    except Exception as error:
        log(f"[tile-list 오류] {type(error).__name__}: {error}")
        if args.debug:
            log(traceback.format_exc())
        return 1
    finally:
        if log_file is not None:
            log_file.close()


def main() -> int:
    args = parse_args()
    if args.tile_list is not None:
        return run_tile_list_batch(args)
    if (
        args.neighbors_of is not None
        or args.diagonals_of is not None
        or args.batch_tile_bbox is not None
    ):
        return run_neighbor_batch(args)
    if args.tile_bbox is not None:
        return process_single_tile(args)
    print(
        "[오류] --tile-bbox, --tile-list 또는 지정한 배치 옵션이 필요합니다.",
        flush=True,
    )
    return 2


if __name__ == "__main__":
    sys.exit(main())
