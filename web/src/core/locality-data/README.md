# Bundled locality gazetteer

`cities.json` derives from **GeoNames geographical data**, provided by GeoNames:
<https://www.geonames.org/>.

The data uses the **Creative Commons Attribution 4.0 International** license:
<https://creativecommons.org/licenses/by/4.0/>. GeoNames supplies the data
without a warranty of accuracy, completeness, or timeliness. This derived
extract does not imply endorsement by GeoNames.

## Source and changes

The source files were downloaded on 2026-11-09:

- <https://download.geonames.org/export/dump/cities15000.zip>
  - SHA-256: `955ad298b67a60996a15b4c4c84c8ca6923bafed195622227f24fd22a31042f4`
- <https://download.geonames.org/export/dump/admin1CodesASCII.txt>
  - SHA-256: `2e4867f5397acb056ea26377601b57af37cb4c81399770225018e9e439e91ad3`

The extract contains 31,782 populated places. It excludes city sections,
grouped places, abandoned places, destroyed places, and historical places. Each tuple contains:

`[latitude × 10000, longitude × 10000, Unicode city name, country code, region or null]`

Coordinates round to 4 decimal places. US and Canadian regions use validated
postal abbreviations. Other regions use the English ASCII administrative name
from `admin1CodesASCII.txt`, not an invented abbreviation. Missing regions remain
`null`. The extract omits other GeoNames fields and alternate names. Records use
one line each, sorted by country, region, name and coordinates for stable diffs.

Run `generate.py` with local copies of both source files to update the extract.
The generator does not download anything. The current JSON uses 1,487,477 bytes,
or about 467 KB with gzip. The worker loads it only when a person requests an
automatic locality lookup. The app can precache its generated JavaScript chunk.

## Meaning and privacy

This is a **nearest populated place lookup**, not reverse geocoding by municipal
boundaries. It cannot prove that a point belongs to a city, state, or country.
A result must say **Near**. The region belongs to the selected populated place.
The lookup rejects comparable candidates from different countries or known
regions. It uses a 5 km ambiguity margin, or twice the reported accuracy when
that is greater. This is a conservative heuristic, not a boundary test.

A result can still select a place across an administrative boundary. The point
dataset cannot identify water near a coast. A boat near a city can get a **Near**
label. Distant ocean fixes, rural places, islands and small settlements can have
no result within the 25 km distance limit. The whole reported accuracy radius
must fit inside that limit. Fixes worse than 5 km produce no result.

The lookup runs in the core worker. It does not request map tiles or send
coordinates to this server, GeoNames, or a geocoder. The bundled chunk URL has
no coordinate-dependent path or parameters. The lookup does not store a trail.
Sharing a derived label needs separate, explicit encrypted-profile consent.

An app that displays derived labels must also display GeoNames attribution and
the CC BY 4.0 license link, such as in its location-sharing settings. The UI must
preserve the approximate meaning and must not imply exact municipal membership.
