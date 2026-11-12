"""
Фаза 0: Проверка дали данните са достъпни и достатъчни.
Изисква: pip install requests pandas
Употреба: python phase0_check.py --firms-key YOUR_KEY
"""
import argparse
import requests
import pandas as pd
from io import StringIO

# Граничен правоъгълник на България
BBOX = "22.36,41.24,28.61,44.21"  # min_lon,min_lat,max_lon,max_lat

# 4 точки: София, Пловдив, Варна, Стара Загора
POINTS = [
    ("София",       42.698, 23.322),
    ("Пловдив",     42.150, 24.750),
    ("Варна",       43.214, 27.914),
    ("Стара Загора",42.426, 25.638),
]


def check_firms(key: str) -> int:
    """Тегли VIIRS пожари за България 2018-2025 и връща броя редове."""
    url = (
        f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}"
        f"/VIIRS_SNPP_NRT/{BBOX}/1/2024-01-01"  # последните 1 ден като тест
    )
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    df = pd.read_csv(StringIO(r.text))
    print(f"  FIRMS тест (1 ден): {len(df)} реда, колони: {list(df.columns)[:5]}")

    # Исторически данни: използваме archive endpoint
    # https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/VIIRS_SNPP_SP/{bbox}/{days}
    # Максимум 10 дни на заявка; за целия период ще трябва цикъл.
    # Тук само проверяваме, че API-то отговаря.
    return len(df)


def check_openmeteo() -> None:
    """Тегли исторически метео за 4 точки и отпечатва броя дни."""
    variables = "temperature_2m_max,relative_humidity_2m_max,wind_speed_10m_max,precipitation_sum"
    for name, lat, lon in POINTS:
        url = (
            "https://archive-api.open-meteo.com/v1/archive"
            f"?latitude={lat}&longitude={lon}"
            "&start_date=2024-01-01&end_date=2024-01-07"
            f"&daily={variables}&timezone=Europe%2FSofia"
        )
        r = requests.get(url, timeout=30)
        r.raise_for_status()
        data = r.json()
        days = len(data["daily"]["time"])
        print(f"  {name}: {days} дни метео ✓")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--firms-key", required=True, help="NASA FIRMS MAP_KEY")
    args = parser.parse_args()

    print("\n=== FIRMS ===")
    try:
        check_firms(args.firms_key)
        print("  FIRMS API: ✓")
    except Exception as e:
        print(f"  FIRMS API: ✗ ({e})")

    print("\n=== Open-Meteo ===")
    try:
        check_openmeteo()
        print("  Open-Meteo: ✓")
    except Exception as e:
        print(f"  Open-Meteo: ✗ ({e})")

    print("\n=== Следваща стъпка ===")
    print("Ако и двете са ✓, пусни download_firms_full.py за пълните данни 2018-2025.")


if __name__ == "__main__":
    main()
