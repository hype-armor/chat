#!/usr/bin/env python3
"""Derive the bundled approximate gazetteer from downloaded GeoNames files.

Usage: python3 generate.py /path/to/cities15000.zip /path/to/admin1CodesASCII.txt
This script does not fetch data. See README.md for sources and attribution.
"""
import hashlib
import json
import re
import sys
import unicodedata
import zipfile
from pathlib import Path

cities_path, admins_path = map(Path, sys.argv[1:])
admins = {}
for line in admins_path.read_text(encoding="utf-8").splitlines():
    fields = line.split("\t")
    if len(fields) >= 4:
        admins[fields[0]] = fields[2]

# These codes are postal abbreviations, not arbitrary GeoNames/FIPS codes.
us_postal = set("AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY".split())
canadian_postal = {
    "Alberta": "AB", "British Columbia": "BC", "Manitoba": "MB", "New Brunswick": "NB",
    "Newfoundland and Labrador": "NL", "Nova Scotia": "NS", "Ontario": "ON",
    "Prince Edward Island": "PE", "Quebec": "QC", "Saskatchewan": "SK",
    "Yukon": "YT", "Northwest Territories": "NT", "Nunavut": "NU",
}
rows = []
with zipfile.ZipFile(cities_path) as archive:
    for line in archive.read("cities15000.txt").decode("utf-8").splitlines():
        fields = line.split("\t")
        name, country, code = fields[1], fields[8], fields[10]
        # Do not present city sections, grouped places, abandoned, destroyed,
        # or historical settlements as a person's nearby city.
        if fields[7] not in {"PPL", "PPLA", "PPLA2", "PPLA3", "PPLA4", "PPLA5", "PPLC", "PPLL", "PPLG", "STLMT", "PPLF", "PPLR"}:
            continue
        # Keep Unicode names, but omit names that profile text cannot safely use.
        if not name or len(name) > 80 or name != name.strip() or re.search(r"[<>\x00-\x1f\x7f]", name) or any(unicodedata.category(char) in ("Cc", "Cf") for char in name):
            continue
        key = country + "." + code
        region = None
        if key in admins:
            if country == "US":
                region = code if code in us_postal else None
            elif country == "CA":
                region = canadian_postal.get(admins[key])
            else:
                region = admins[key]
        rows.append([round(float(fields[4]) * 10_000), round(float(fields[5]) * 10_000), name, country, region])

output = Path(__file__).with_name("cities.json")
rows.sort(key=lambda row: (row[3], row[4] or "", row[2].casefold(), row[0], row[1]))
# One complete record per line gives stable, reviewable data updates.
output.write_text("[\n" + ",\n".join(json.dumps(row, ensure_ascii=False, separators=(",", ":")) for row in rows) + "\n]\n", encoding="utf-8")
print(f"Wrote {len(rows)} places, {output.stat().st_size} bytes")
for path in (cities_path, admins_path):
    print(path.name, hashlib.sha256(path.read_bytes()).hexdigest())
