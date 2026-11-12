import json
import tempfile
import unittest
from pathlib import Path

import pandas as pd

from . import train


class CellDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_data_dir = train.DATA_DIR
        train.DATA_DIR = Path(self.temp_dir.name)
        boundary = {
            "type": "Polygon",
            "coordinates": [[[22.36, 41.24], [22.46, 41.24], [22.46, 41.34],
                             [22.36, 41.34], [22.36, 41.24]]],
        }
        (train.DATA_DIR / "bulgaria_boundary.geojson").write_text(json.dumps(boundary))

    def tearDown(self):
        train.DATA_DIR = self.original_data_dir
        self.temp_dir.cleanup()

    def test_grid_matches_cell_size_and_assigns_nearest_vegetation(self):
        cells = train.build_cell_grid([(41.29, 22.41, 2)])
        self.assertEqual(cells, [{"lat": 41.29, "lon": 22.41, "veg_type": 2}])

    def test_builds_cell_day_labels_with_weather_lags(self):
        dates = pd.date_range("2023-12-30", periods=5, freq="D")
        meteo = pd.DataFrame({
            "date": dates,
            "lat": 41.3,
            "lon": 22.4,
            "temp": [8, 8, 9, 10, 11],
            "humidity": [75, 74, 73, 72, 71],
            "wind_speed": [10, 10, 11, 12, 12],
            "precip": [1.5, 0, 0, 0, 0],
            "month": dates.month,
        })
        firms = pd.DataFrame({
            "latitude": [41.30],
            "longitude": [22.42],
            "acq_date": [pd.Timestamp("2024-01-02")],
        })

        dataset = train.build_dataset(firms, meteo, [(41.29, 22.41, 1)])

        self.assertEqual(dataset.attrs["training_resolution"], "0.1-degree map cells")
        self.assertEqual(dataset.attrs["cell_count"], 1)
        self.assertEqual(len(dataset), 2)
        self.assertEqual(int(dataset["fire"].sum()), 1)
        self.assertIn("fwi_lag1", dataset.columns)
        self.assertEqual(int(dataset.loc[dataset["fire"] == 1, "veg_type"].iloc[0]), 1)


if __name__ == "__main__":
    unittest.main()
