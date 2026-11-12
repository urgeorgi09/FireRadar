"""
Фаза 3: ML Pipeline за пожарен риск.

1. Зарежда FIRMS от data/firms_bulgaria_2018_2025.csv
2. Изтегля исторически метео от Open-Meteo Archive
3. Добавя CORINE Land Cover 2018 (data/clc2018_bgr.geojson) като feature
4. Обучава LightGBM (baseline: само FWI)
5. Оценява с AUC, precision, recall
6. Експортира в ONNX + model_meta.json
7. Записва results.md

Употреба:
  python ml/train.py
"""
import time, json
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import lightgbm as lgb
from sklearn.metrics import roc_auc_score, precision_score, recall_score

DATA_DIR = Path("data")
ML_DIR   = Path("ml")

# ── Представителни метео точки за наличния архив ────────────────────────────
REP_POINTS = [
    (round(lat, 1), round(lon, 1))
    for lat in np.arange(41.5, 44.1, 1.0)
    for lon in np.arange(22.5, 28.6, 1.0)
]
CELL_STEP = 0.1
CELL_MIN_LAT, CELL_MAX_LAT = 41.24, 44.21
CELL_MIN_LON, CELL_MAX_LON = 22.36, 28.61

# ── CLC кодове → vegetation type (горими vs негорими) ────────────────────────
# 1=гора, 2=храсталаци/преходни, 3=земеделие, 4=друго
def clc_code_to_veg(code: str) -> int:
    try:
        c = int(str(code)[:3])
    except (ValueError, TypeError):
        return 4
    if c in (311, 312, 313):          return 1  # широколистна, иглолистна, смесена гора
    if c in (321, 322, 323, 324, 333): return 2  # храсталаци, преходни зони
    if 200 <= c <= 244:                return 3  # земеделски земи
    return 4                                      # урбанизирани, водни, др.


def load_clc_cell_centroids() -> list[tuple[float, float, int]]:
    source = DATA_DIR / "clc2018_bgr.geojson"
    cache = DATA_DIR / "clc_polygon_centroids.json"
    if not source.exists():
        print("  CLC файл не е намерен — veg_type=4 за всички клетки")
        return []

    stat = source.stat()
    if cache.exists():
        try:
            cached = json.loads(cache.read_text(encoding="utf-8"))
            if cached.get("source_size") == stat.st_size and cached.get("source_mtime_ns") == stat.st_mtime_ns:
                return [tuple(row) for row in cached["centroids"]]
        except (OSError, ValueError, KeyError, TypeError):
            pass

    from shapely.geometry import shape

    print("  Зареждам CORINE полигони за клетките...")
    raw = json.loads(source.read_text(encoding="utf-8"))
    centroids = []
    for feature in raw.get("features", []):
        try:
            min_lon, min_lat, max_lon, max_lat = shape(feature["geometry"]).bounds
            centroids.append((
                (min_lat + max_lat) / 2,
                (min_lon + max_lon) / 2,
                clc_code_to_veg(feature["properties"].get("Code_18", "")),
            ))
        except (KeyError, TypeError, ValueError):
            continue

    cache.write_text(json.dumps({
        "source_size": stat.st_size,
        "source_mtime_ns": stat.st_mtime_ns,
        "centroids": centroids,
    }), encoding="utf-8")
    print(f"  [OK] Записани {len(centroids)} CLC центроида в кеш")
    return centroids


def build_cell_grid(clc_centroids: list[tuple[float, float, int]]) -> list[dict]:
    from shapely import get_dimensions
    from shapely.geometry import box, shape

    boundary_data = json.loads((DATA_DIR / "bulgaria_boundary.geojson").read_text(encoding="utf-8"))
    if boundary_data.get("type") == "FeatureCollection":
        from shapely.ops import unary_union
        boundary = unary_union([shape(feature["geometry"]) for feature in boundary_data["features"]])
    elif boundary_data.get("type") == "Feature":
        boundary = shape(boundary_data["geometry"])
    else:
        boundary = shape(boundary_data)

    cells = []
    lat = CELL_MIN_LAT
    while lat < CELL_MAX_LAT:
        lon = CELL_MIN_LON
        while lon < CELL_MAX_LON:
            center_lat = round(lat + CELL_STEP / 2, 4)
            center_lon = round(lon + CELL_STEP / 2, 4)
            intersection = box(
                center_lon - CELL_STEP / 2,
                center_lat - CELL_STEP / 2,
                center_lon + CELL_STEP / 2,
                center_lat + CELL_STEP / 2,
            ).intersection(boundary)
            if get_dimensions(intersection) == 2 and intersection.area > 0:
                cells.append({"lat": center_lat, "lon": center_lon})
            lon += CELL_STEP
        lat += CELL_STEP

    if clc_centroids:
        points = np.asarray([(row[0], row[1]) for row in clc_centroids], dtype=np.float32)
        vegetation = np.asarray([row[2] for row in clc_centroids], dtype=np.int8)
        for cell in cells:
            distances = np.square(points[:, 0] - cell["lat"]) + np.square(points[:, 1] - cell["lon"])
            cell["veg_type"] = int(vegetation[int(np.argmin(distances))])
    else:
        for cell in cells:
            cell["veg_type"] = 4
    return cells


# ── 1. FIRMS ──────────────────────────────────────────────────────────────────
def load_firms() -> pd.DataFrame:
    path = DATA_DIR / "firms_bulgaria_2018_2025.csv"
    print(f"  Зареждам FIRMS от {path}...")
    df = pd.read_csv(path, parse_dates=["acq_date"])
    df = df[df["acq_date"] < "2025-01-01"]   # само до края на 2024
    print(f"  [OK] {len(df)} засичания, {df['acq_date'].nunique()} дати (2018-2024)")
    return df


# ── 2. Open-Meteo Archive ─────────────────────────────────────────────────────
def load_meteo() -> pd.DataFrame:
    cache = DATA_DIR / "meteo_2018_2024.csv"
    if cache.exists():
        print(f"  Метео кеш: {cache}")
        df = pd.read_csv(cache, parse_dates=["date"])
        # Ако кешът е от старата версия (без humidity_min), го изтриваме
        if 'humidity' in df.columns and df['humidity'].mean() > 60:
            print("  [WARN] Кешът изглежда от старата версия (humidity_max) — изтривам и свалям отново")
            cache.unlink()
        else:
            return df

    print(f"  Изтеглям метео (hourly, обедни стойности) за {len(REP_POINTS)} точки 2018-2024...")
    frames = []
    for i, (lat, lon) in enumerate(REP_POINTS):
        # Взимаме hourly за да извлечем 12:00 стойности (изискване на FWI стандарта)
        url = (
            f"https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={lat}&longitude={lon}"
            f"&start_date=2018-01-01&end_date=2024-12-31"
            f"&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m"
            f"&daily=precipitation_sum"
            f"&timezone=Europe%2FSofia&wind_speed_unit=kmh"
        )
        for attempt in range(4):
            try:
                r = requests.get(url, timeout=60)
                if r.status_code == 429:
                    time.sleep(5 * (attempt + 1)); continue
                r.raise_for_status()
                j = r.json()
                dates = j["daily"]["time"]
                frames.append(pd.DataFrame({
                    "date":       pd.to_datetime(dates),
                    "lat": lat, "lon": lon,
                    # Обедни стойности: индекс 12 в hourly (00:00 е 0, 12:00 е 12)
                    "temp":       [j["hourly"]["temperature_2m"][di*24+12] for di in range(len(dates))],
                    "humidity":   [j["hourly"]["relative_humidity_2m"][di*24+12] for di in range(len(dates))],
                    "wind_speed": [j["hourly"]["wind_speed_10m"][di*24+12] for di in range(len(dates))],
                    "precip":     j["daily"]["precipitation_sum"],
                    "month":      [int(d[5:7]) for d in dates],
                }))
                break
            except Exception as e:
                print(f"    Грешка ({lat},{lon}) опит {attempt+1}: {e}")
                time.sleep(2)
        time.sleep(0.4)
        if (i + 1) % 5 == 0:
            print(f"    {i+1}/{len(REP_POINTS)} точки")

    df = pd.concat(frames, ignore_index=True)
    df.to_csv(cache, index=False)
    print(f"  [OK] Метео: {len(df)} реда (обедни стойности)")
    return df


# ── 3. FWI (Van Wagner 1987 — истинска реализация с памет) ───────────────────
DAY_LENGTH = [6.5, 7.5, 9.0, 12.8, 13.9, 13.9, 12.4, 10.9, 9.2, 8.0, 7.0, 6.0]
DC_FACTOR  = [-1.6,-1.6,-1.6,  0.9,  3.8,  5.8,  6.4,  5.0, 2.4, 0.4,-1.6,-1.6]

def ffmc_next(f0, T, H, W, r):
    mo = (147.2 * (101 - f0)) / (59.5 + f0)
    if r > 0.5:
        rf = r - 0.5
        mr = mo + 42.5 * rf * np.exp(-100 / (251 - mo)) * (1 - np.exp(-6.93 / rf))
        mr = np.where(mo > 150, mr + 0.0015 * (mo - 150)**2 * np.sqrt(rf), mr)
        mo = np.minimum(mr, 250)
    Ed = 0.942 * H**0.679 + 11 * np.exp((H - 100) / 10) + 0.18 * (21.1 - T) * (1 - np.exp(-0.115 * H))
    Ew = 0.618 * H**0.753 + 10 * np.exp((H - 100) / 10) + 0.18 * (21.1 - T) * (1 - np.exp(-0.115 * H))
    ko = 0.424 * (1 - (H / 100)**1.7) + 0.0694 * np.sqrt(W) * (1 - (H / 100)**8)
    kd = ko * 0.581 * np.exp(0.0365 * T)
    k1 = 0.424 * (1 - ((100 - H) / 100)**1.7) + 0.0694 * np.sqrt(W) * (1 - ((100 - H) / 100)**8)
    kw = k1 * 0.581 * np.exp(0.0365 * T)
    m = np.where(mo > Ed, Ed + (mo - Ed) * 10**(-kd),
        np.where(mo < Ew, Ew - (Ew - mo) * 10**(-kw), mo))
    return np.clip((59.5 * (250 - m)) / (147.2 + m), 0, 101)

def dmc_next(d0, T, H, r, month):
    T = np.maximum(T, -1.1)
    dl = DAY_LENGTH[int(month) - 1] if np.isscalar(month) else np.array([DAY_LENGTH[int(m)-1] for m in month])
    rk = 1.894 * (T + 1.1) * (100 - H) * dl * 1e-4
    d = d0.copy() if hasattr(d0, 'copy') else d0
    mask = r > 1.5
    if np.any(mask):
        re = 0.92 * r - 1.27
        mo = 20 + np.exp(5.6348 - d0 / 43.43)
        b = np.where(d0 <= 33, 100 / (0.5 + 0.3 * d0),
            np.where(d0 <= 65, 14 - 1.3 * np.log(np.maximum(d0, 1)),
                               6.2 * np.log(np.maximum(d0, 1)) - 17.2))
        mr = mo + (1000 * re) / (48.77 + b * re)
        d_wet = np.maximum(244.72 - 43.43 * np.log(np.maximum(mr - 20, 0.001)), 0)
        d = np.where(mask, d_wet, d)
    return d + rk

def dc_next(d0, T, r, month):
    T = np.maximum(T, -2.8)
    dcf = DC_FACTOR[int(month) - 1] if np.isscalar(month) else np.array([DC_FACTOR[int(m)-1] for m in month])
    pe = np.maximum((0.36 * (T + 2.8) + dcf) / 2, 0)
    d = d0.copy() if hasattr(d0, 'copy') else d0
    mask = r > 2.8
    if np.any(mask):
        rd = 0.83 * r - 1.27
        qo = 800 * np.exp(-d0 / 400)
        d_wet = np.maximum(400 * np.log(800 / (qo + 3.937 * rd)), 0)
        d = np.where(mask, d_wet, d)
    return d + pe

def isi_calc(ffmc, wind):
    fm = (147.2 * (101 - ffmc)) / (59.5 + ffmc)
    fF = 91.9 * np.exp(-0.1386 * fm) * (1 + fm**5.31 / 4.93e7)
    return 0.208 * np.exp(0.05039 * wind) * fF

def bui_calc(dmc, dc):
    b1 = (0.8 * dmc * dc) / np.maximum(dmc + 0.4 * dc, 1e-9)
    b2 = dmc - (1 - (0.8 * dc) / np.maximum(dmc + 0.4 * dc, 1e-9)) * (0.92 + (0.0114 * dmc)**1.7)
    return np.maximum(0, np.where(dmc <= 0.4 * dc, b1, b2))

def fwi_calc(isi_v, bui_v):
    fD = np.where(bui_v <= 80,
                  0.626 * bui_v**0.809 + 2,
                  1000 / (25 + 108.64 * np.exp(-0.023 * bui_v)))
    B = 0.1 * isi_v * fD
    logarithm = np.maximum(0.434 * np.log(np.maximum(B, 1)), 0)
    return np.where(B > 1, np.exp(2.72 * logarithm**0.647), B)

def compute_fwi_series(df_point: pd.DataFrame) -> pd.DataFrame:
    """
    Изчислява FWI серията за един метео ред.
    df_point трябва да е сортиран по дата за дадена точка.
    Връща df с добавени колони: ffmc, dmc, dc, isi, bui, fwi.
    """
    n = len(df_point)
    ffmc = np.full(n, 85.0)
    dmc  = np.full(n, 6.0)
    dc   = np.full(n, 15.0)
    isi_arr = np.zeros(n)
    bui_arr = np.zeros(n)
    fwi_arr = np.zeros(n)

    for i in range(n):
        r = df_point.iloc[i]
        f = ffmc_next(ffmc[i-1] if i > 0 else 85.0,
                      r['temp'], r['humidity'], r['wind_speed'], r['precip'])
        d = dmc_next(dmc[i-1] if i > 0 else 6.0,
                     r['temp'], r['humidity'], r['precip'], r['month'])
        dc_ = dc_next(dc[i-1] if i > 0 else 15.0,
                      r['temp'], r['precip'], r['month'])
        ffmc[i] = f; dmc[i] = d; dc[i] = dc_
        isi_arr[i] = isi_calc(f, r['wind_speed'])
        bui_arr[i] = bui_calc(d, dc_)
        fwi_arr[i] = fwi_calc(isi_arr[i], bui_arr[i])

    result = df_point.copy()
    result['ffmc'] = ffmc
    result['dmc']  = dmc
    result['dc']   = dc
    result['isi']  = isi_arr
    result['bui']  = bui_arr
    result['fwi']  = np.round(fwi_arr, 2)
    return result


# ── 5. Обучителна таблица ─────────────────────────────────────────────────────
def build_dataset(
    firms: pd.DataFrame,
    meteo: pd.DataFrame,
    clc_centroids: list[tuple[float, float, int]],
) -> pd.DataFrame:
    print("  Строя обучителна таблица за 0.1° клетка-дни...")
    cells = build_cell_grid(clc_centroids)
    if not cells:
        raise ValueError("Не са генерирани клетки в границата на България")

    meteo = meteo.copy()
    meteo["lat"] = meteo["lat"].round(1)
    meteo["lon"] = meteo["lon"].round(1)
    meteo["date"] = pd.to_datetime(meteo["date"]).dt.normalize()
    if "month" not in meteo.columns:
        meteo["month"] = meteo["date"].dt.month
    dates = pd.DatetimeIndex(sorted(meteo["date"].unique()))
    date_index = {date.strftime("%Y-%m-%d"): i for i, date in enumerate(dates)}

    matrix_features = [feature for feature in ALL_FEATURES if feature != "veg_type"]
    feature_matrices = {feature: [] for feature in matrix_features}
    point_coords = []
    print("  Изчислявам FWI и лагове за метео точките...")
    for (point_lat, point_lon), group in meteo.groupby(["lat", "lon"], sort=True):
        point = compute_fwi_series(group.sort_values("date").reset_index(drop=True))
        if not pd.DatetimeIndex(point["date"]).equals(dates):
            raise ValueError(f"Метео редовете за точка {point_lat},{point_lon} не покриват общите дати")
        point["doy"] = point["date"].dt.day_of_year
        for lag in [1, 2, 3]:
            point[f"fwi_lag{lag}"] = point["fwi"].shift(lag)
            point[f"temp_lag{lag}"] = point["temp"].shift(lag)
            point[f"precip_lag{lag}"] = point["precip"].shift(lag)
        point_coords.append((point_lat, point_lon))
        for feature in matrix_features:
            feature_matrices[feature].append(point[feature].to_numpy(dtype=np.float32))

    if not point_coords:
        raise ValueError("Не са налични метео точки за обучение")
    point_coords_array = np.asarray(point_coords, dtype=np.float32)
    cell_coords = np.asarray([(cell["lat"], cell["lon"]) for cell in cells], dtype=np.float32)
    nearest_points = np.argmin(
        np.square(cell_coords[:, None, :] - point_coords_array[None, :, :]).sum(axis=2),
        axis=1,
    )

    valid_days = len(dates) - 3
    if valid_days <= 0:
        raise ValueError("Нужни са поне четири последователни метео дни за FWI лаговете")
    row_count = len(cells) * valid_days
    data = {
        feature: np.vstack(feature_matrices[feature])[nearest_points, 3:].reshape(-1)
        for feature in matrix_features
    }
    valid_dates = dates[3:]
    data["cell_id"] = np.repeat(np.arange(len(cells), dtype=np.int32), valid_days)
    data["date"] = np.tile(valid_dates.to_numpy(), len(cells))
    data["month"] = np.tile(valid_dates.month.to_numpy(dtype=np.int8), len(cells))
    data["doy"] = np.tile(valid_dates.day_of_year.to_numpy(dtype=np.int16), len(cells))
    data["fire"] = np.zeros(row_count, dtype=np.int8)

    cell_index = {}
    for i, cell in enumerate(cells):
        row = round((cell["lat"] - CELL_MIN_LAT - CELL_STEP / 2) / CELL_STEP)
        col = round((cell["lon"] - CELL_MIN_LON - CELL_STEP / 2) / CELL_STEP)
        cell_index[(row, col)] = i

    fires = firms.copy()
    fires["date"] = pd.to_datetime(fires["acq_date"]).dt.normalize()
    fires["row"] = np.floor((fires["latitude"] - CELL_MIN_LAT) / CELL_STEP).astype(int)
    fires["col"] = np.floor((fires["longitude"] - CELL_MIN_LON) / CELL_STEP).astype(int)
    labels = set()
    for fire in fires[["row", "col", "date"]].drop_duplicates().itertuples(index=False):
        cell_id = cell_index.get((fire.row, fire.col))
        day_index = date_index.get(fire.date.strftime("%Y-%m-%d"))
        if cell_id is not None and day_index is not None and day_index >= 3:
            labels.add(cell_id * valid_days + day_index - 3)
    if labels:
        data["fire"][np.fromiter(labels, dtype=np.int64)] = 1

    data["veg_type"] = np.repeat(
        np.asarray([cell["veg_type"] for cell in cells], dtype=np.int8),
        valid_days,
    )
    df = pd.DataFrame(data)
    df.attrs["training_resolution"] = "0.1-degree map cells"
    df.attrs["cell_count"] = len(cells)
    print(
        f"  [OK] {len(df):,} клетка-дни, {len(cells)} клетки, "
        f"{int(df['fire'].sum()):,} пожарни клетка-дни ({df['fire'].mean()*100:.3f}%)"
    )
    print(f"  FWI средно: {df['fwi'].mean():.1f}, макс: {df['fwi'].max():.1f}")
    return df


# ── 6. Обучение ───────────────────────────────────────────────────────────────
WEATHER_FEATURES = ["temp", "humidity", "wind_speed", "precip"]
FDI_FEATURES = WEATHER_FEATURES + ["fwi"]
LAG_FEATURES = FDI_FEATURES + [
    "ffmc", "dmc", "dc", "isi", "bui", "veg_type",
    "fwi_lag1", "fwi_lag2", "fwi_lag3",
    "temp_lag1", "temp_lag2", "temp_lag3",
    "precip_lag1", "precip_lag2", "precip_lag3",
]
FEATURE_SETS = {
    "weather": WEATHER_FEATURES,
    "weather_fdi": FDI_FEATURES,
    "weather_fdi_lag": LAG_FEATURES,
    "weather_fdi_lag_calendar": LAG_FEATURES + ["month", "doy"],
}
ALL_FEATURES = list(dict.fromkeys(feature for features in FEATURE_SETS.values() for feature in features))

def sample_month_matched_training_rows(
    df: pd.DataFrame,
    training_mask: np.ndarray | None = None,
) -> pd.DataFrame:
    if training_mask is None:
        training_mask = np.ones(len(df), dtype=bool)
    training_indices = np.flatnonzero(training_mask)
    fire = df["fire"].to_numpy()[training_indices]
    months = df["month"].to_numpy()[training_indices]
    selected_indices = []
    rng = np.random.default_rng(42)
    for month in np.unique(months[fire == 1]):
        month_indices = np.flatnonzero(months == month)
        positives = month_indices[fire[month_indices] == 1]
        negatives = month_indices[fire[month_indices] == 0]
        sample_count = min(len(negatives), int(len(positives) * 4))
        selected_indices.extend(training_indices[positives].tolist())
        if sample_count:
            selected_indices.extend(training_indices[
                rng.choice(negatives, size=sample_count, replace=False)
            ].tolist())
    if not selected_indices:
        raise ValueError("Няма отрицателни примери за месеците с положителни примери")
    return df.iloc[selected_indices].sample(frac=1, random_state=42)


def real_precision(y_true, prediction, prevalence):
    tp = int(((y_true == 1) & (prediction == 1)).sum())
    fn = int(((y_true == 1) & (prediction == 0)).sum())
    fp = int(((y_true == 0) & (prediction == 1)).sum())
    tn = int(((y_true == 0) & (prediction == 0)).sum())
    tpr = tp / (tp + fn) if tp + fn else 0
    fpr = fp / (fp + tn) if fp + tn else 0
    denominator = tpr * prevalence + fpr * (1 - prevalence)
    return tpr * prevalence / denominator if denominator else 0


def build_classifier(X_train, y_train, X_test, y_test):
    positives = int((y_train == 1).sum())
    negatives = int((y_train == 0).sum())
    if not positives or not negatives:
        raise ValueError("Обучителната извадка трябва да има и двата класа")
    model = lgb.LGBMClassifier(
        n_estimators=400,
        learning_rate=0.05,
        num_leaves=63,
        min_child_samples=20,
        scale_pos_weight=negatives / positives,
        random_state=42,
        verbose=-1,
    )
    model.fit(
        X_train, y_train,
        eval_set=[(X_test, y_test)],
        callbacks=[lgb.early_stopping(40, verbose=False), lgb.log_evaluation(50)],
    )
    return model


def train(df: pd.DataFrame):
    train_mask = (df["date"] < "2024-01-01").to_numpy()
    test_mask = ~train_mask
    sampled_train = sample_month_matched_training_rows(df, train_mask)
    train_indices = np.flatnonzero(train_mask)
    calibration_indices = np.random.default_rng(42).choice(
        train_indices, size=min(200_000, len(train_indices)), replace=False
    )
    calibration_natural = df.iloc[calibration_indices]
    test_features = list(dict.fromkeys(FEATURE_SETS["weather_fdi_lag"] + ["month", "doy"]))
    test_df = df.loc[test_mask, ["fire", *test_features]]
    y_test = test_df["fire"].values
    if len(np.unique(y_test)) != 2:
        raise ValueError("Тестовият период трябва да съдържа положителни и отрицателни примери")

    print(
        f"  Train natural: {int(train_mask.sum()):,} | "
        f"Train sampled: {len(sampled_train):,} | Test: {len(test_df):,}"
    )

    fwi_test = test_df["fwi"].values
    baseline_prediction = (fwi_test >= 15).astype(int)
    baseline = {
        "auc": float(roc_auc_score(y_test, fwi_test)),
        "precision": float(precision_score(y_test, baseline_prediction, zero_division=0)),
        "recall": float(recall_score(y_test, baseline_prediction, zero_division=0)),
        "real_precision": float(real_precision(y_test, baseline_prediction, float(y_test.mean()))),
    }

    ablations = {}
    models = {}
    calibration_scores = {}
    for name, features in FEATURE_SETS.items():
        model = build_classifier(
            sampled_train[features], sampled_train["fire"].values,
            test_df[features], y_test,
        )
        probabilities = model.predict_proba(test_df[features])[:, 1]
        natural_train_scores = model.predict_proba(calibration_natural[features])[:, 1]
        high_threshold = float(np.percentile(natural_train_scores, 85))
        prediction = (probabilities >= high_threshold).astype(int)
        ablations[name] = {
            "auc": float(roc_auc_score(y_test, probabilities)),
            "precision": float(precision_score(y_test, prediction, zero_division=0)),
            "recall": float(recall_score(y_test, prediction, zero_division=0)),
            "real_precision": float(real_precision(y_test, prediction, float(y_test.mean()))),
            "high_risk_threshold": high_threshold,
        }
        models[name] = model
        calibration_scores[name] = natural_train_scores
        print(f"  {name}: AUC={ablations[name]['auc']:.3f} P={ablations[name]['precision']:.3f} "
              f"real-P={ablations[name]['real_precision']:.3f} R={ablations[name]['recall']:.3f} "
              f"high-score-cut={high_threshold:.3f}")

    operational_name = "weather_fdi_lag"
    calendar_name = "weather_fdi_lag_calendar"
    selected_name = operational_name if (
        ablations[operational_name]["auc"] >= ablations[calendar_name]["auc"] - 0.02
    ) else calendar_name
    model = models[selected_name]
    features = FEATURE_SETS[selected_name]
    train_probabilities = calibration_scores[selected_name]
    thresholds = {
        "moderate": float(np.percentile(train_probabilities, 60)),
        "high": float(np.percentile(train_probabilities, 85)),
        "extreme": float(np.percentile(train_probabilities, 95)),
    }
    importance = pd.Series(model.feature_importances_, index=features).sort_values(ascending=False)
    print(f"  Operational version: {selected_name} ({len(features)} features)")
    print(f"  Relative-risk percentiles: {thresholds}")

    selected = ablations[selected_name]
    return model, {
        "baseline": {key: round(value, 3) for key, value in baseline.items()},
        "lgbm": {key: round(value, 3) for key, value in selected.items()},
        "ablations": {
            name: {key: round(value, 3) for key, value in metrics.items()}
            for name, metrics in ablations.items()
        },
        "importance": importance.round(1).to_dict(),
        "features": features,
        "operational_version": selected_name,
        "train_rows": int(train_mask.sum()),
        "test_rows": len(test_df),
        "fire_rate": round(float(df.loc[train_mask, "fire"].mean()), 5),
        "test_fire_rate": float(y_test.mean()),
        "percentile_thresholds": thresholds,
        "training_resolution": df.attrs.get("training_resolution", "unknown"),
        "cell_count": df.attrs.get("cell_count"),
        "calibration_note": (
            f"Обучението е съпоставено по месец; π={y_test.mean():.5f} е естествената честота "
            "в тестовите клетка-дни на същата 0.1° мрежа като картата."
        ),
    }


# ── 7. ONNX Export ────────────────────────────────────────────────────────────
def export_onnx(model, results: dict):
    import onnxmltools
    from onnxmltools.convert import convert_lightgbm
    from onnxmltools.convert.common.data_types import FloatTensorType

    features = results["features"]
    initial_type = [("float_input", FloatTensorType([None, len(features)]))]
    onnx_model = convert_lightgbm(
        model.booster_, initial_types=initial_type, target_opset=12, zipmap=False
    )
    onnx_path = ML_DIR / "fire_risk.onnx"
    onnx_path.write_bytes(onnx_model.SerializeToString())
    print(f"  [OK] ONNX: {onnx_path}")

    (ML_DIR / "model_meta.json").write_text(
        json.dumps({
            "features": features,
            "risk_thresholds": results["percentile_thresholds"],
            "risk_semantics": "relative",
            "training_resolution": results.get("training_resolution"),
            "cell_count": results.get("cell_count"),
            "test_fire_prevalence": results.get("test_fire_rate"),
        }, indent=2),
        encoding="utf-8",
    )
    print("  [OK] model_meta.json")


# ── 8. results.md ─────────────────────────────────────────────────────────────
def write_results(results: dict):
    b, l = results["baseline"], results["lgbm"]
    imp  = results["importance"]
    top5 = list(imp.keys())[:5]
    pt   = results.get("percentile_thresholds", {})
    cal  = results.get("calibration_note", "")
    md = f"""# FireRadar — Резултати от ML модела

## Данни
- Период: 2018–2024 (обучение до 2023, тест 2024)
- Пространствена единица: 0.1° клетка-дни, съвпадаща с резолюцията на картата
- Брой клетки: {results.get('cell_count', '—')}
- Обучителни редове: {results['train_rows']:,}
- Тестови редове: {results['test_rows']:,}
- Честота на пожари в обучителните данни: {results['fire_rate']*100:.2f}%
- Метео: Open-Meteo Archive, обедни стойности; FWI и лаговете са изчислени последователно за метео точките, после присвоени към най-близката клетка

## Сравнение: Baseline vs LightGBM

| Метрика | Baseline (непрекъснат FDI) | Оперативен LightGBM |
|---|---:|---:|
| AUC | {b['auc']:.3f} | {l['auc']:.3f} |
| Precision (FWI ≥15 baseline / 85-и score процентил при ML) | {b['precision']:.3f} | {l['precision']:.3f} |
| Precision с π от тестовата извадка | {b['real_precision']:.5f} | {l['real_precision']:.5f} |
| Recall / TPR при този праг | {b['recall']:.3f} | {l['recall']:.3f} |

Precision е оценена при праг за висок относителен риск, определен като 85-и процентил от тренировъчните оценки.
`TPR·π / (TPR·π + FPR·(1−π))` използва π={results['test_fire_rate']:.6f}, естествената честота
в тестовите клетка-дни от същата 0.1° мрежа като картата. Рискът остава относителен, не абсолютна вероятност.

## Аблация на признаците

| Версия | AUC | Precision | Precision с π от тестовата извадка | Recall |
|---|---:|---:|---:|---:|
{chr(10).join(f"| {name} | {metrics['auc']:.3f} | {metrics['precision']:.3f} | {metrics['real_precision']:.5f} | {metrics['recall']:.3f} |" for name, metrics in results['ablations'].items())}

Избрана оперативна версия: `{results['operational_version']}`. Метеорологичният вариант без `month`/`doy`
се избира, когато AUC изостава с не повече от 0.02.

## Прагове за нива на риск (процентили от тренировъчните данни)

| Ниво | Праг (score) | Тълкуване |
|------|:------------:|-----------|
| Умерен | ≥ {pt.get('moderate', '?')} | 60-и процентил |
| Висок | ≥ {pt.get('high', '?')} | 85-и процентил |
| Екстремен | ≥ {pt.get('extreme', '?')} | 95-и процентил |

## Топ 5 признака по важност
{chr(10).join(f'{i+1}. `{f}` ({imp[f]:.0f})' for i, f in enumerate(top5))}

## Бележки за интерпретация
- {cal}
- Разделяне по ВРЕМЕ (не случайно) за реалистична оценка
- Отрицателните обучителни примери са семплирани със същото месечно разпределение като положителните.
- Нивото е относителен риск, не калибрирана абсолютна вероятност за пожар.
- Модел: LightGBM → ONNX → зареден в Node.js API

## Ограничения
- Метеорологичните измервания остават от по-рядка мрежа и се присвояват към най-близката клетка
- FIRMS засича и нелесни пожари (стърнища, промишленост)
- Кулите и дроновете са симулирани данни
"""
    Path("results.md").write_text(md, encoding="utf-8")
    print("  [OK] results.md")


# ── Main ──────────────────────────────────────────────────────────────────────
def main():
    print("\n=== FireRadar ML Pipeline ===\n")

    print("1. FIRMS данни...")
    firms = load_firms()

    print("\n2. Метео данни...")
    meteo = load_meteo()

    print("\n3. CLC land cover...")
    clc_centroids = load_clc_cell_centroids()

    print("\n4. Обучителна таблица...")
    df = build_dataset(firms, meteo, clc_centroids)

    print("\n5. Обучение...")
    model, results = train(df)

    print("\n6. ONNX export...")
    export_onnx(model, results)

    print("\n7. Резултати...")
    write_results(results)

    print("\n[OK] Готово! Виж results.md и ml/fire_risk.onnx\n")


if __name__ == "__main__":
    main()
