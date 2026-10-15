import math
import uuid
from datetime import datetime
from pathlib import Path

import folium
import pandas as pd
import streamlit as st
from streamlit_folium import st_folium


st.set_page_config(
    page_title="천호 안심 밤길",
    page_icon="🌙",
    layout="wide",
    initial_sidebar_state="collapsed",
)

CENTER = (37.5385, 127.1275)
DATA_FILE = Path("data.csv")
UPLOAD_DIR = Path("reports_uploads")
DATA_COLUMNS = [
    "record_type",
    "id",
    "name",
    "lat",
    "lon",
    "status",
    "issue_type",
    "description",
    "location",
    "photo_name",
    "created_at",
]


def initial_lamps():
    return pd.DataFrame(
        [
            {
                "id": "L-001",
                "name": "천호역 2번 출구 앞",
                "lat": 37.53875,
                "lon": 127.12725,
                "status": "working",
            },
            {
                "id": "L-002",
                "name": "천호공원 입구",
                "lat": 37.54555,
                "lon": 127.12590,
                "status": "working",
            },
            {
                "id": "L-003",
                "name": "천호대로 골목 진입부",
                "lat": 37.54110,
                "lon": 127.13120,
                "status": "working",
            },
            {
                "id": "L-004",
                "name": "강동구청 뒤편",
                "lat": 37.53095,
                "lon": 127.12355,
                "status": "working",
            },
        ]
    )


def initial_cctv():
    return pd.DataFrame(
        [
            {
                "id": "C-001",
                "name": "천호역 안심귀갓길 CCTV",
                "lat": 37.53835,
                "lon": 127.12705,
            },
            {"id": "C-002", "name": "천호공원 CCTV", "lat": 37.54585, "lon": 127.12615},
            {
                "id": "C-003",
                "name": "강동구청 사거리 CCTV",
                "lat": 37.53065,
                "lon": 127.12310,
            },
        ]
    )


def ensure_data_file():
    if DATA_FILE.exists():
        return
    lamps = initial_lamps().assign(
        record_type="lamp",
        issue_type="",
        description="",
        location="",
        photo_name="",
        created_at="",
    )
    cctv = initial_cctv().assign(
        record_type="cctv",
        status="working",
        issue_type="",
        description="",
        location="",
        photo_name="",
        created_at="",
    )
    seed = pd.concat([lamps, cctv], ignore_index=True)[DATA_COLUMNS]
    seed.to_csv(DATA_FILE, index=False, encoding="utf-8-sig")


def load_data_file():
    ensure_data_file()
    data = pd.read_csv(DATA_FILE, encoding="utf-8-sig")
    for column in DATA_COLUMNS:
        if column not in data.columns:
            data[column] = ""
    return data[DATA_COLUMNS]


def initialize_state():
    data = load_data_file()
    st.session_state.data = data
    st.session_state.lamps = data[data.record_type == "lamp"].copy()
    st.session_state.cctv = data[data.record_type == "cctv"].copy()
    st.session_state.reports = (
        data[data.record_type == "report"].fillna("").to_dict("records")
    )
    if "report_lat" not in st.session_state:
        st.session_state.report_lat = CENTER[0]
    if "report_lon" not in st.session_state:
        st.session_state.report_lon = CENTER[1]


def save_report(issue_type, location, lat, lon, description, photo):
    data = load_data_file()
    nearest_id = ""
    if issue_type == "가로등 고장":
        lamps = data[data.record_type == "lamp"].copy()
        if not lamps.empty:
            lamps["distance"] = lamps.apply(
                lambda row: distance_meters(lat, lon, row.lat, row.lon), axis=1
            )
            nearest = lamps.sort_values("distance").iloc[0]
            if nearest.distance <= 100:
                nearest_id = nearest.id
                data.loc[data.id == nearest.id, "status"] = "broken"

    photo_name = ""
    if photo:
        UPLOAD_DIR.mkdir(exist_ok=True)
        photo_name = (
            f"{datetime.now():%Y%m%d_%H%M%S}_{uuid.uuid4().hex[:8]}_{photo.name}"
        )
        (UPLOAD_DIR / photo_name).write_bytes(photo.getvalue())

    report = pd.DataFrame(
        [
            {
                "record_type": "report",
                "id": f"R-{uuid.uuid4().hex[:10]}",
                "name": nearest_id,
                "lat": lat,
                "lon": lon,
                "status": "reported",
                "issue_type": issue_type,
                "description": description,
                "location": location,
                "photo_name": photo_name,
                "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            }
        ],
        columns=DATA_COLUMNS,
    )
    pd.concat([data, report], ignore_index=True)[DATA_COLUMNS].to_csv(
        DATA_FILE, index=False, encoding="utf-8-sig"
    )


def distance_meters(lat1, lon1, lat2, lon2):
    lat_scale = 111_000
    lon_scale = 111_000 * math.cos(math.radians((lat1 + lat2) / 2))
    return math.hypot((lat2 - lat1) * lat_scale, (lon2 - lon1) * lon_scale)


def nearby_count(points, lat, lon, radius):
    if points.empty:
        return 0
    return sum(
        distance_meters(lat, lon, row.lat, row.lon) <= radius
        for row in points.itertuples()
    )


def route_points(start, end, variant):
    start_lat, start_lon = start
    end_lat, end_lon = end
    mid_lat = (start_lat + end_lat) / 2
    mid_lon = (start_lon + end_lon) / 2
    offsets = [(0.0011, -0.0003), (-0.0009, 0.0009), (0.0016, 0.0011)]
    off_lat, off_lon = offsets[variant]
    return [start, (mid_lat + off_lat, mid_lon + off_lon), end]


def route_metrics(points):
    lamps = st.session_state.lamps
    cctv = st.session_state.cctv
    healthy_lamps = lamps[lamps.status == "working"]
    broken_lamps = lamps[lamps.status == "broken"]
    samples = []
    for first, second in zip(points, points[1:]):
        for step in range(11):
            ratio = step / 10
            samples.append(
                (
                    first[0] + (second[0] - first[0]) * ratio,
                    first[1] + (second[1] - first[1]) * ratio,
                )
            )
    lamp_hits = sum(nearby_count(healthy_lamps, lat, lon, 85) for lat, lon in samples)
    cctv_hits = sum(nearby_count(cctv, lat, lon, 130) for lat, lon in samples)
    broken_hits = sum(nearby_count(broken_lamps, lat, lon, 85) for lat, lon in samples)
    distance = sum(distance_meters(*a, *b) for a, b in zip(points, points[1:]))
    score = max(0, min(100, 45 + lamp_hits * 1.4 + cctv_hits * 0.8 - broken_hits * 5))
    return {
        "distance": distance,
        "score": score,
        "lamps": lamp_hits,
        "cctv": cctv_hits,
        "broken": broken_hits,
    }


def route_color(score):
    if score >= 75:
        return "#16a34a"
    if score >= 50:
        return "#eab308"
    return "#dc2626"


def build_map(start, end, selected_route):
    fmap = folium.Map(
        location=CENTER, zoom_start=15, tiles="OpenStreetMap", control_scale=True
    )
    route_coords = [point for route in selected_route for point in route["points"]]
    if route_coords:
        south = min(point[0] for point in route_coords)
        west = min(point[1] for point in route_coords)
        north = max(point[0] for point in route_coords)
        east = max(point[1] for point in route_coords)
        fmap.fit_bounds([[south, west], [north, east]], padding=(28, 28))
    folium.Marker(
        start, tooltip="출발지", icon=folium.Icon(color="blue", icon="play")
    ).add_to(fmap)
    folium.Marker(
        end, tooltip="도착지", icon=folium.Icon(color="red", icon="flag")
    ).add_to(fmap)

    for row in st.session_state.lamps.itertuples():
        color = "green" if row.status == "working" else "red"
        label = "정상 가로등" if row.status == "working" else "고장 제보 가로등"
        folium.CircleMarker(
            (row.lat, row.lon),
            radius=6,
            color=color,
            fill=True,
            fill_opacity=0.9,
            tooltip=f"{label}: {row.name}",
        ).add_to(fmap)
    for row in st.session_state.cctv.itertuples():
        folium.CircleMarker(
            (row.lat, row.lon),
            radius=5,
            color="blue",
            fill=True,
            fill_opacity=0.9,
            tooltip=f"CCTV: {row.name}",
        ).add_to(fmap)

    for index, route in enumerate(selected_route):
        points = route["points"]
        metrics = route["metrics"]
        folium.PolyLine(
            points,
            color=route_color(metrics["score"]),
            weight=7 if index == 0 else 4,
            opacity=0.95 if index == 0 else 0.55,
            tooltip=f"{route['name']} · 안전도 {metrics['score']:.0f}점",
        ).add_to(fmap)
    return fmap


def render_report_form():
    st.subheader("현장 상황 제보하기")
    st.caption(
        "제보는 data.csv와 reports_uploads/에 저장되어 다음 실행에도 유지됩니다."
    )
    clicked = st_folium(
        folium.Map(
            location=(st.session_state.report_lat, st.session_state.report_lon),
            zoom_start=16,
        ),
        height=260,
        key="report_picker",
    )
    if clicked and clicked.get("last_clicked"):
        st.session_state.report_lat = clicked["last_clicked"]["lat"]
        st.session_state.report_lon = clicked["last_clicked"]["lng"]
        st.info("지도에서 선택한 좌표를 입력값에 반영했습니다.")

    with st.form("report_form", clear_on_submit=True):
        issue_type = st.selectbox(
            "제보 유형",
            [
                "가로등 고장",
                "CCTV 누락",
                "안심벨 고장",
                "어두운 골목",
                "기타 안전 문제",
            ],
        )
        location = st.text_input(
            "상세 위치", placeholder="예: 천호역 3번 출구에서 천호공원 방향 100m"
        )
        lat = st.number_input(
            "위도", value=float(st.session_state.report_lat), format="%.6f"
        )
        lon = st.number_input(
            "경도", value=float(st.session_state.report_lon), format="%.6f"
        )
        description = st.text_area(
            "문제점 설명", placeholder="현장에서 본 문제를 자세히 적어주세요."
        )
        photo = st.file_uploader(
            "현장 사진",
            type=["jpg", "jpeg", "png"],
            help="데모 저장을 위해 2MB 이하 사진만 허용합니다.",
        )
        submitted = st.form_submit_button(
            "제보 적용", type="primary", use_container_width=True
        )

    if submitted:
        if not location.strip() or not description.strip():
            st.error("상세 위치와 문제점 설명을 입력해주세요.")
            return
        if photo and photo.size > 2 * 1024 * 1024:
            st.error("사진은 2MB 이하로 올려주세요.")
            return
        save_report(issue_type, location, lat, lon, description, photo)
        st.session_state.report_flash = "신고가 완료되어 지도에 반영되었습니다."
        st.rerun()


def render_reports():
    st.subheader("레포트 함")
    st.caption(f"data.csv에 저장된 제보 {len(st.session_state.reports)}건")
    if not st.session_state.reports:
        st.info("아직 등록된 제보가 없습니다.")
        return
    for report in st.session_state.reports:
        with st.container(border=True):
            st.markdown(f"### {report['issue_type']}")
            st.caption(
                f"{report['created_at']} · {report['location']} · {float(report['lat']):.6f}, {float(report['lon']):.6f}"
            )
            st.write(report["description"])
            if report.get("name"):
                st.warning(f"가로등 {report['name']}를 고장 상태로 반영했습니다.")
            if report.get("photo_name"):
                photo_path = UPLOAD_DIR / str(report["photo_name"])
                if photo_path.exists():
                    st.image(str(photo_path), width=420)


def main():
    initialize_state()
    st.title("천호동 안심 밤길")
    st.caption("가로등·CCTV 상태와 현장 제보를 반영하는 세션 기반 안전 지도")
    start = (37.53835, 127.12707)
    end = (37.53095, 127.12320)
    route_options = []
    for variant, name in enumerate(
        ["큰길 중심 경로", "가로등 밀집 경로", "대체 보행 경로"]
    ):
        points = route_points(start, end, variant)
        route_options.append(
            {"name": name, "points": points, "metrics": route_metrics(points)}
        )
    route_options.sort(
        key=lambda route: (-route["metrics"]["score"], route["metrics"]["distance"])
    )

    map_tab = st.tabs(["지도 보기"])[0]
    with map_tab:
        best = route_options[0]
        st.metric(
            "현재 추천 안전도",
            f"{best['metrics']['score']:.0f}점",
            f"가로등 근접 {best['metrics']['lamps']} · CCTV 근접 {best['metrics']['cctv']}",
        )
        st_folium(
            build_map(start, end, route_options),
            height=680,
            use_container_width=True,
            key="main_map",
        )
        st.info(
            "지도 선 색상은 현재 session_state의 정상 가로등·CCTV 데이터로 다시 계산됩니다."
        )


if __name__ == "__main__":
    main()
