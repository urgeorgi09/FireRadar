"""
Сваля:
  1. Граница на България (GeoJSON) от GADM
  2. CORINE Land Cover 2018 (GeoJSON) от EEA ArcGIS REST API — само България
Записва в data/
"""

import os
import json
import time
import requests

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
os.makedirs(DATA_DIR, exist_ok=True)

# ── 1. Граница на България (GADM level-0, GeoJSON) ───────────────────────────
print("\n[1/2] Граница на България")
boundary_dest = os.path.join(DATA_DIR, "bulgaria_boundary.geojson")

if os.path.exists(boundary_dest):
    print(f"  ✓ Вече е свален ({os.path.getsize(boundary_dest)//1024} KB)")
else:
    print("  ↓ Сваляне от GADM 4.1...")
    r = requests.get(
        "https://geodata.ucdavis.edu/gadm/gadm4.1/json/gadm41_BGR_0.json",
        timeout=60
    )
    r.raise_for_status()
    with open(boundary_dest, "wb") as f:
        f.write(r.content)
    print(f"  ✓ Записан ({os.path.getsize(boundary_dest)//1024} KB)")


# ── 2. CORINE Land Cover 2018 — България (EEA ArcGIS REST) ───────────────────
# Endpoint: https://image.discomap.eea.europa.eu/arcgis/rest/services/Corine/CLC2018_WM/MapServer/0
# Слой 0 = CLC 2018 vector, ~65 302 полигона за bbox на България
print("\n[2/2] CORINE Land Cover 2018 — България (EEA ArcGIS REST)")

CLC_DEST = os.path.join(DATA_DIR, "clc2018_bgr.geojson")
BASE_URL = (
    "https://image.discomap.eea.europa.eu/arcgis/rest/services"
    "/Corine/CLC2018_WM/MapServer/0/query"
)
BGR_BBOX = {"xmin": 22.36, "ymin": 41.24, "xmax": 28.61, "ymax": 44.21}
PAGE_SIZE = 1000

if os.path.exists(CLC_DEST):
    print(f"  ✓ Вече е свален ({os.path.getsize(CLC_DEST)//1024} KB)")
else:
    # Брой записи
    r = requests.get(BASE_URL, params={
        "where": "1=1",
        "geometry": json.dumps(BGR_BBOX),
        "geometryType": "esriGeometryEnvelope",
        "inSR": "4326",
        "returnCountOnly": "true",
        "f": "json",
    }, timeout=30)
    total = r.json()["count"]
    print(f"  Общо полигони: {total}")

    features = []
    offset = 0
    while offset < total:
        params = {
            "where": "1=1",
            "geometry": json.dumps(BGR_BBOX),
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "outFields": "Code_18,Area_Ha",
            "returnGeometry": "true",
            "outSR": "4326",
            "resultOffset": offset,
            "resultRecordCount": PAGE_SIZE,
            "f": "geojson",
        }
        for attempt in range(4):
            try:
                resp = requests.get(BASE_URL, params=params, timeout=60)
                resp.raise_for_status()
                page = resp.json()
                break
            except Exception as e:
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))

        batch = page.get("features", [])
        features.extend(batch)
        offset += len(batch)
        print(f"\r  {offset}/{total} полигона", end="", flush=True)
        if batch:
            time.sleep(0.3)  # учтивост към сървъра

    print()
    geojson = {"type": "FeatureCollection", "features": features}
    with open(CLC_DEST, "w", encoding="utf-8") as f:
        json.dump(geojson, f, ensure_ascii=False)
    print(f"  ✓ Записан ({os.path.getsize(CLC_DEST)//1024} KB, {len(features)} полигона)")


# ── Обобщение ─────────────────────────────────────────────────────────────────
print("\n── Резултат ──────────────────────────────────────────────────────────")
for fname in ["bulgaria_boundary.geojson", "clc2018_bgr.geojson"]:
    path = os.path.join(DATA_DIR, fname)
    if os.path.exists(path):
        print(f"  ✓ {fname}  ({os.path.getsize(path)//1024} KB)")
    else:
        print(f"  ✗ {fname}  — ЛИПСВА")
print()
