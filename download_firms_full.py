"""
Сваля VIIRS пожари за България 2018-2025 от NASA FIRMS.
Записва data/firms_bulgaria_2018_2025.csv
"""
import argparse, time, requests, pandas as pd
from io import StringIO
from pathlib import Path
from datetime import date, timedelta

# FIRMS иска bbox като отделни параметри или като encoded string
# Правилният формат: lon_min,lat_min,lon_max,lat_max БЕЗ интервали
BBOX = "22.36,41.24,28.61,44.21"
OUT  = Path("data/firms_bulgaria_2018_2025.csv")


def date_range(start: date, end: date, chunk: int):
    cur = start
    while cur <= end:
        yield cur, min(cur + timedelta(days=chunk - 1), end)
        cur += timedelta(days=chunk)


def download(key: str):
    OUT.parent.mkdir(exist_ok=True)
    frames = []
    start, end = date(2018, 1, 1), date(2025, 6, 30)
    chunks = list(date_range(start, end, 5))  # SP позволява макс 5 дни
    print(f"Общо заявки: {len(chunks)}")

    for i, (s, e) in enumerate(chunks):
        days = (e - s).days + 1
        product = "VIIRS_SNPP_NRT" if s >= date(2025, 4, 1) else "VIIRS_SNPP_SP"
        url = f"https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{product}/{BBOX}/{days}/{s.isoformat()}"

        try:
            r = requests.get(url, timeout=60)
            if r.status_code == 400:
                # Опитай с NRT
                url2 = url.replace("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT")
                r = requests.get(url2, timeout=60)
            r.raise_for_status()
            text = r.text.strip()
            if text and '\n' in text:  # има поне header + 1 ред
                df = pd.read_csv(StringIO(text))
                if len(df) > 0:
                    frames.append(df)
        except Exception as ex:
            print(f"  Грешка при {s}: {ex}")
        
        if (i + 1) % 30 == 0:
            total = sum(len(f) for f in frames)
            print(f"  {i+1}/{len(chunks)} ({s}) — {total} реда")
        time.sleep(0.4)

    if not frames:
        print("ГРЕШКА: Няма данни! Провери ключа.")
        return

    result = pd.concat(frames, ignore_index=True)
    result.to_csv(OUT, index=False)
    print(f"\nЗаписано: {OUT}")
    print(f"Редове: {len(result)}")
    print(f"Период: {result['acq_date'].min()} → {result['acq_date'].max()}")
    print(f"Уникални дати: {result['acq_date'].nunique()}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--firms-key", required=True)
    args = parser.parse_args()
    download(args.firms_key)
