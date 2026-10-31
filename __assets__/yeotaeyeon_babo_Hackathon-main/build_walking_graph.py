#!/usr/bin/env python3
"""Build a bounded OpenStreetMap walking graph for engine.mjs."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parent
DEFAULT_INPUT = ROOT / "south-korea-261025.osm.pbf"
DEFAULT_OUTPUT = ROOT / "data" / "generated" / "changwon-walking.json"
DEFAULT_BBOX = (128.66, 35.20, 128.70, 35.24)
EARTH_RADIUS_M = 6_371_008.8
TAG_COLUMNS = [
    "access",
    "access:conditional",
    "addr:housenumber",
    "addr:street",
    "amenity",
    "barrier",
    "bridge",
    "crossing",
    "foot",
    "foot:conditional",
    "footway",
    "highway",
    "indoor",
    "lit",
    "motor_vehicle",
    "name",
    "oneway",
    "oneway:foot",
    "place",
    "public_transport",
    "railway",
    "service",
    "shop",
    "subway",
    "surface",
    "tourism",
    "tunnel",
]
BLOCKED_ACCESS = {"no", "private", "customers", "permit", "delivery", "destination"}
BLOCKED_FOOT = {
    "no",
    "private",
    "customers",
    "permit",
    "delivery",
    "destination",
    "limited",
    "use_sidepath",
}
ALLOWED_FOOT_OVERRIDE = {"yes", "designated", "permissive"}
ONEWAY_FOOT = {"yes", "true", "1", "-1", "reverse"}


def report(message: str) -> None:
    print(message, flush=True)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="지정한 경계 안의 보행 OSM 그래프를 engine.mjs 형식 JSON으로 변환합니다."
    )
    parser.add_argument(
        "--input", type=Path, default=DEFAULT_INPUT, help="입력 PBF 경로"
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="새 JSON 출력 경로 (기존 파일은 덮어쓰지 않음)",
    )
    parser.add_argument(
        "--bbox",
        type=float,
        nargs=4,
        metavar=("WEST", "SOUTH", "EAST", "NORTH"),
        default=DEFAULT_BBOX,
        help="경도/위도 경계. 기본값은 창원 도심 소구역",
    )
    parser.add_argument(
        "--buffer-meters",
        type=float,
        default=500,
        help="요청 경계 바깥에서 연결을 보존할 완충 거리(미터)",
    )
    parser.add_argument(
        "--region",
        default="창원 테스트 영역",
        help="결과 메타데이터에 표시할 지역 이름",
    )
    parser.add_argument(
        "--debug", action="store_true", help="오류 발생 시 전체 traceback 표시"
    )
    return parser.parse_args()


def validate_bbox(
    bbox: list[float] | tuple[float, ...],
) -> tuple[float, float, float, float]:
    if len(bbox) != 4 or not all(math.isfinite(value) for value in bbox):
        raise ValueError("--bbox는 유한한 숫자 4개(WEST SOUTH EAST NORTH)여야 합니다.")
    west, south, east, north = bbox
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ValueError("--bbox 경계 순서 또는 경도·위도 범위가 올바르지 않습니다.")
    return west, south, east, north


def expand_bbox(
    bbox: tuple[float, float, float, float], buffer_meters: float
) -> tuple[float, float, float, float]:
    if not math.isfinite(buffer_meters) or buffer_meters < 0:
        raise ValueError("--buffer-meters는 0 이상의 유한한 숫자여야 합니다.")
    west, south, east, north = bbox
    mid_lat = math.radians((south + north) / 2)
    lat_pad = buffer_meters / 111_195
    lon_pad = buffer_meters / max(1, 111_195 * math.cos(mid_lat))
    return (
        max(-180, west - lon_pad),
        max(-90, south - lat_pad),
        min(180, east + lon_pad),
        min(90, north + lat_pad),
    )


def text_value(row: Any, key: str) -> str:
    value = row.get(key)
    if value is None:
        return ""
    if isinstance(value, float) and math.isnan(value):
        return ""
    value = str(value).strip()
    return "" if value.lower() in {"nan", "none", "<na>"} else value


def access_block_reason(row: Any) -> str | None:
    foot = text_value(row, "foot").lower()
    access = text_value(row, "access").lower()
    foot_oneway = text_value(row, "oneway:foot").lower()
    if text_value(row, "access:conditional") or text_value(row, "foot:conditional"):
        return "conditional_access"
    if foot in BLOCKED_FOOT:
        return "foot_restricted"
    if access in BLOCKED_ACCESS and foot not in ALLOWED_FOOT_OVERRIDE:
        return "access_restricted"
    if foot_oneway in ONEWAY_FOOT:
        return "unsupported_foot_direction"
    return None


def point_xy(row: Any) -> tuple[float, float] | None:
    geometry = row.get("geometry")
    if geometry is not None and hasattr(geometry, "x") and hasattr(geometry, "y"):
        point = (float(geometry.x), float(geometry.y))
    else:
        lon, lat = row.get("lon"), row.get("lat")
        if lon is None or lat is None:
            return None
        point = (float(lon), float(lat))
    return point if all(math.isfinite(value) for value in point) else None


def line_coordinates(geometry: Any) -> list[list[float]] | None:
    if geometry is None or not hasattr(geometry, "coords"):
        return None
    try:
        points = [[float(lon), float(lat)] for lon, lat, *_ in geometry.coords]
    except (AttributeError, NotImplementedError, TypeError, ValueError):
        return None
    if len(points) < 2 or any(
        not all(math.isfinite(value) for value in point) for point in points
    ):
        return None
    return points


def meters_between(
    a: list[float] | tuple[float, float], b: list[float] | tuple[float, float]
) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * EARTH_RADIUS_M * math.asin(min(1, math.sqrt(h)))


def geometry_length(points: list[list[float]]) -> float:
    return sum(meters_between(points[i - 1], points[i]) for i in range(1, len(points)))


def graph_components(
    node_count: int, edges: list[dict[str, Any]]
) -> tuple[list[list[int]], list[int]]:
    adjacency = [[] for _ in range(node_count)]
    degree = [0] * node_count
    for edge in edges:
        a, b = edge["a"], edge["b"]
        adjacency[a].append(b)
        adjacency[b].append(a)
        degree[a] += 1
        degree[b] += 1
    components: list[list[int]] = []
    seen = bytearray(node_count)
    for start in range(node_count):
        if seen[start]:
            continue
        seen[start] = 1
        queue = [start]
        for node in queue:
            for next_node in adjacency[node]:
                if not seen[next_node]:
                    seen[next_node] = 1
                    queue.append(next_node)
        components.append(queue)
    return components, degree


def source_snapshot(path: Path) -> str:
    match = re.search(r"(\d{6})(?=\.osm\.pbf$)", path.name)
    if not match:
        return "unknown"
    try:
        return datetime.strptime(match.group(1), "%y%m%d").date().isoformat()
    except ValueError:
        return "unknown"


def read_places(
    osm: Any, core_bbox: tuple[float, float, float, float]
) -> list[dict[str, Any]]:
    pois = osm.get_pois(custom_filter={"amenity": True, "shop": True, "tourism": True})
    if pois is None or pois.empty:
        return []
    west, south, east, north = core_bbox
    places: list[dict[str, Any]] = []
    seen: set[str] = set()
    for _, row in pois.iterrows():
        name = text_value(row, "name")
        geometry = row.get("geometry")
        if not name or geometry is None or getattr(geometry, "is_empty", True):
            continue
        point = geometry if hasattr(geometry, "x") else geometry.representative_point()
        lon, lat = float(point.x), float(point.y)
        if not (west <= lon <= east and south <= lat <= north):
            continue
        osm_id = f"{text_value(row, 'osm_type')}/{text_value(row, 'id')}"
        if osm_id in seen:
            continue
        seen.add(osm_id)
        street = text_value(row, "addr:street")
        number = text_value(row, "addr:housenumber")
        places.append(
            {
                "name": name,
                "address": " ".join(part for part in (street, number) if part),
                "p": [lon, lat],
                "osmId": osm_id,
                "kind": text_value(row, "amenity")
                or text_value(row, "shop")
                or text_value(row, "tourism"),
            }
        )
    return places


def build_data(
    nodes_gdf: Any,
    edges_gdf: Any,
    places: list[dict[str, Any]],
    *,
    input_path: Path,
    region: str,
    core_bbox: tuple[float, float, float, float],
    extract_bbox: tuple[float, float, float, float],
) -> dict[str, Any]:
    if nodes_gdf is None or edges_gdf is None or edges_gdf.empty:
        raise ValueError(
            "이 경계 안에서 보행 간선을 찾지 못했습니다. bbox를 넓혀 다시 시도하세요."
        )
    required_edge_columns = {"u", "v", "id", "geometry"}
    missing = required_edge_columns.difference(edges_gdf.columns)
    if missing:
        raise ValueError(
            f"Pyrosm 간선 결과에 필요한 열이 없습니다: {', '.join(sorted(missing))}"
        )
    if "id" not in nodes_gdf.columns:
        raise ValueError("Pyrosm 노드 결과에 OSM 노드 id 열이 없습니다.")

    node_points: dict[int, tuple[float, float]] = {}
    for _, row in nodes_gdf.iterrows():
        try:
            node_id = int(row.get("id"))
        except (TypeError, ValueError, OverflowError):
            continue
        point = point_xy(row)
        if point:
            node_points[node_id] = point

    records: list[dict[str, Any]] = []
    excluded_access = 0
    excluded_direction = 0
    invalid_edges = 0
    used_node_ids: set[int] = set()
    for _, row in edges_gdf.iterrows():
        reason = access_block_reason(row)
        if reason:
            if reason == "unsupported_foot_direction":
                excluded_direction += 1
            else:
                excluded_access += 1
            continue
        try:
            u, v = int(row.get("u")), int(row.get("v"))
            way_id = str(int(row.get("id")))
        except (TypeError, ValueError, OverflowError):
            invalid_edges += 1
            continue
        if u == v or u not in node_points or v not in node_points:
            invalid_edges += 1
            continue
        points = line_coordinates(row.get("geometry"))
        if not points:
            invalid_edges += 1
            continue
        start_error = meters_between(points[0], node_points[u]) + meters_between(
            points[-1], node_points[v]
        )
        reverse_error = meters_between(points[0], node_points[v]) + meters_between(
            points[-1], node_points[u]
        )
        if reverse_error < start_error:
            points.reverse()
        if min(start_error, reverse_error) > 20:
            invalid_edges += 1
            continue
        try:
            distance = float(row.get("length"))
        except (TypeError, ValueError, OverflowError):
            distance = 0
        if not math.isfinite(distance) or distance <= 0:
            distance = geometry_length(points)
        if not math.isfinite(distance) or distance <= 0:
            invalid_edges += 1
            continue
        crossing_tag = text_value(row, "crossing").lower()
        records.append(
            {
                "u": u,
                "v": v,
                "way": way_id,
                "geometry": points,
                "distance": round(distance, 3),
                "highway": text_value(row, "highway") or "walking",
                "crossing": (bool(crossing_tag) and crossing_tag != "no")
                or text_value(row, "highway") == "crossing",
            }
        )
        used_node_ids.update((u, v))

    if not records:
        raise ValueError("접근 제한·방향 검사 후 남은 보행 간선이 없습니다.")

    ordered_ids = sorted(used_node_ids)
    node_index = {node_id: index for index, node_id in enumerate(ordered_ids)}
    output_nodes = [
        {"id": index, "sourceId": str(node_id), "p": list(node_points[node_id])}
        for index, node_id in enumerate(ordered_ids)
    ]
    output_edges: list[dict[str, Any]] = []
    for record in records:
        highway = record["highway"]
        area = (
            "계단"
            if highway == "steps"
            else "보행로"
            if highway in {"footway", "pedestrian", "path", "corridor"}
            else "도로"
        )
        a, b = node_index[record["u"]], node_index[record["v"]]
        output_edges.append(
            {
                "id": len(output_edges),
                "sourceId": f"{record['way']}_{min(record['u'], record['v'])}_0",
                "a": a,
                "b": b,
                "geometry": record["geometry"],
                "distance": record["distance"],
                "quality": [0, 0, 0],
                "code": highway,
                "crossing": record["crossing"],
                "area": area,
            }
        )

    components, degree = graph_components(len(output_nodes), output_edges)
    largest = max(components, key=len)
    first = largest[0]
    first_point = output_nodes[first]["p"]
    probe_end = max(
        largest, key=lambda index: meters_between(first_point, output_nodes[index]["p"])
    )
    if probe_end == first:
        raise ValueError(
            "보행 연결 그래프가 경로 검증에 필요한 두 노드보다 작습니다. bbox를 넓혀 주세요."
        )

    west, south, east, north = extract_bbox
    edge_tolerance_m = 20
    dangling_outer_nodes = []
    for index, node in enumerate(output_nodes):
        lon, lat = node["p"]
        near_outer = (
            meters_between([lon, lat], [west, lat]) <= edge_tolerance_m
            or meters_between([lon, lat], [east, lat]) <= edge_tolerance_m
            or meters_between([lon, lat], [lon, south]) <= edge_tolerance_m
            or meters_between([lon, lat], [lon, north]) <= edge_tolerance_m
        )
        if near_outer and degree[index] == 1:
            dangling_outer_nodes.append(index)

    core_west, core_south, core_east, core_north = core_bbox
    boundary_crossing_edges = sum(
        any(
            core_west <= lon <= core_east and core_south <= lat <= core_north
            for lon, lat in edge["geometry"]
        )
        and any(
            not (core_west <= lon <= core_east and core_south <= lat <= core_north)
            for lon, lat in edge["geometry"]
        )
        for edge in output_edges
    )

    snapshot = source_snapshot(input_path)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    audit = {
        "nodes": len(output_nodes),
        "links": len(output_edges),
        "snapshot_nodes": len(output_nodes),
        "snapshot_links": len(output_edges),
        "lamps": 0,
        "cctv": 0,
        "bells": 0,
        "component_count": len(components),
        "largest_component_nodes": len(largest),
        "excluded_disconnected_nodes": len(output_nodes) - len(largest),
        "disconnected_node_count": len(output_nodes) - len(largest),
        "duplicate_reverse_edge_records": 0,
        "disconnected_physical_edges": 0,
        "access_excluded_edges": excluded_access,
        "access_filter": "Pyrosm walking filter plus explicit OSM foot/access tag checks",
        "direction_restriction_excluded_edges": excluded_direction,
        "invalid_edges": invalid_edges,
        "boundary_dangling_nodes": len(dangling_outer_nodes),
        "boundary_dangling_node_samples": dangling_outer_nodes[:20],
        "boundary_crossing_edges": boundary_crossing_edges,
        "probe_nodes": [first, probe_end],
        "duplicate_lamp_coordinates": 0,
        "invalid_lamp_coordinates": 0,
        "light_near_length_ratio": None,
        "cctv_near_length_ratio": None,
        "no_vehicle_length_ratio": None,
    }
    boundary = [
        [core_west, core_south],
        [core_east, core_south],
        [core_east, core_north],
        [core_west, core_north],
        [core_west, core_south],
    ]
    actual_bbox = [
        min(node["p"][0] for node in output_nodes),
        min(node["p"][1] for node in output_nodes),
        max(node["p"][0] for node in output_nodes),
        max(node["p"][1] for node in output_nodes),
    ]
    return {
        "meta": {
            "region": region,
            "bbox": actual_bbox,
            "requestedBbox": [core_west, core_south, core_east, core_north],
            "extractBbox": list(extract_bbox),
            "retrieved": snapshot,
            "generatedAt": now,
            "sources": {
                "network": {
                    "name": "OpenStreetMap 보행 링크",
                    "page": "https://www.openstreetmap.org/copyright",
                    "date": snapshot,
                },
                "osm": {
                    "name": "OpenStreetMap",
                    "page": "https://www.openstreetmap.org/copyright",
                    "date": snapshot,
                },
                "lamps": {
                    "name": "보안등 자료 미제공",
                    "page": "https://www.openstreetmap.org/copyright",
                    "date": None,
                },
                "facilities": {
                    "name": "CCTV·안심벨 자료 미제공",
                    "page": "https://www.openstreetmap.org/copyright",
                    "date": None,
                },
            },
            "audit": audit,
            "labels": ["보안등 근접", "등록 CCTV 근접", "차량 통행 없는 길"],
            "radiiMeters": {"lamp": 30, "cctv": 50},
            "networkFieldDate": snapshot,
            "scope": f"{region} OSM 보행자 네트워크 전체 연결 성분 보존",
            "boundary": boundary,
            "facilityCoverageAvailable": False,
            "limitations": [
                "보안등·CCTV·안심벨·차량 통행 여부는 평가하지 않았으며 quality의 0은 시설이 없다는 뜻이 아닙니다.",
                "현재 engine.mjs는 간선을 양방향으로 탐색하므로 oneway:foot 방향 제한이 있는 간선은 제외했습니다.",
                "현재 engine.mjs는 최대 연결 성분만 경로 계산에 사용합니다. 나머지 성분은 임의로 연결하지 않습니다.",
                "바깥 경계의 막다른 노드는 PBF 경계 절단 가능성을 확인해야 합니다.",
            ],
        },
        "nodes": output_nodes,
        "edges": output_edges,
        "facilities": [],
        "places": places,
    }


def main() -> int:
    args = parse_args()
    try:
        core_bbox = validate_bbox(args.bbox)
        extract_bbox = expand_bbox(core_bbox, args.buffer_meters)
        input_path = args.input.expanduser().resolve()
        output_path = args.output.expanduser().resolve()
        if not input_path.is_file():
            raise FileNotFoundError(f"입력 PBF 파일이 없습니다: {input_path}")
        if output_path.name.lower() == "data.json":
            raise ValueError(
                "기존 data.json 보호를 위해 파일명이 data.json인 경로에는 저장할 수 없습니다."
            )
        if output_path.exists():
            raise FileExistsError(
                f"출력 파일이 이미 있습니다. 덮어쓰지 않습니다: {output_path}"
            )

        try:
            from pyrosm import OSM
        except ImportError as error:
            raise RuntimeError(
                "pyrosm 라이브러리를 찾지 못했습니다. Windows 가상환경에서 `python -m pip install pyrosm`을 실행하세요."
            ) from error

        report(f"[1/6] 입력 확인: {input_path}")
        report(f"[2/6] 선택 경계: {core_bbox}; 완충 포함 추출 경계: {extract_bbox}")
        report(
            "[3/6] 지정된 경계의 OSM 보행망을 읽습니다. 전체 국가 그래프는 만들지 않습니다."
        )
        last_progress = [-10]

        def progress(done: int, total: int) -> None:
            if total <= 0:
                return
            percent = int(done * 100 / total)
            if percent >= last_progress[0] + 10 or percent == 100:
                report(f"       PBF 읽기 {percent}%")
                last_progress[0] = percent

        osm = OSM(
            str(input_path),
            bounding_box=list(extract_bbox),
            engine="out_of_core",
            workers=1,
            progress=progress,
        )
        nodes_gdf, edges_gdf = osm.get_network(
            network_type="walking",
            nodes=True,
            tags_to_keep=TAG_COLUMNS,
        )
        report(f"       읽은 노드 {len(nodes_gdf):,}개 · 간선 {len(edges_gdf):,}개")
        report("[4/6] 접근 제한을 검사하고 엔진 형식으로 노드·간선을 구성합니다.")
        data = build_data(
            nodes_gdf,
            edges_gdf,
            [],
            input_path=input_path,
            region=args.region,
            core_bbox=core_bbox,
            extract_bbox=extract_bbox,
        )
        audit = data["meta"]["audit"]
        report("[5/6] 연결 성분·경계 점검을 마치고 선택 영역의 검색 장소를 읽습니다.")
        places = read_places(osm, core_bbox)
        data["places"] = places
        report(
            f"       최종 노드 {audit['nodes']:,}개 · 간선 {audit['links']:,}개 · "
            f"연결 성분 {audit['component_count']:,}개 · 검색 장소 {len(places):,}개"
        )
        if audit["component_count"] > 1:
            report(
                "       경고: 여러 연결 성분이 있습니다. engine.mjs에서는 최대 성분만 경로에 사용됩니다."
            )
        if audit["boundary_dangling_nodes"]:
            report(
                f"       경고: 바깥 추출 경계의 차수 1 노드 {audit['boundary_dangling_nodes']}개는 "
                "경계 연결을 추가 확인해야 합니다."
            )
        if not audit["boundary_crossing_edges"]:
            report(
                "       경고: 요청 경계를 통과하는 간선이 없습니다. bbox가 도로망을 자르는지 확인하세요."
            )
        output_path.parent.mkdir(parents=True, exist_ok=True)
        report(f"[6/6] 별도 JSON 저장: {output_path}")
        with output_path.open("x", encoding="utf-8") as output_file:
            json.dump(
                data,
                output_file,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            output_file.write("\n")
        report(
            f"완료: {output_path.stat().st_size:,} bytes. data.json은 변경하지 않았습니다."
        )
        return 0
    except Exception as error:
        report(f"[오류] {type(error).__name__}: {error}")
        if args.debug:
            raise
        return 1


if __name__ == "__main__":
    sys.exit(main())
