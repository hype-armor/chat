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
or about 467 KB with gzip. The worker loads it lazily to derive a nearby-city
header from a peer's authenticated location or live update deliberately shared
in that conversation. This needs no global setting or additional location fix.
The app can precache the generated JavaScript chunk.
Lazy loading and lookup run outside the exclusive receive-processing lock.
Block, stop, sign-out, and membership processing must not wait for the dataset.
After lookup, re-enter `exclusive()` only to validate the current source and publish.
Recheck account, conversation eligibility, source identity, membership, ordering,
expiry, and stop or block tombstones. Discard stale results.

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
[ADR-0042](../../../../docs/adr/0042-conversation-scoped-derived-locality.md)
limits this lookup to coordinates the peer deliberately shared through the
existing **Send location** or live-share controls in that conversation.
Those actions supply consent; there is no global automatic-location service,
standalone coarse broadcast, or encrypted-profile locality publication.
Own messages, groups, requests, and other conversations cannot supply a direct
recipient header. Legacy standalone locality bodies must not supply it either.

The derived header expires within 1 hour of the source's validated original
timestamp, or sooner when its live session expires. Points retain authenticated
source-device and session provenance. Within the conversation, stop tombstones
use the canonical peer account and session, not the source device. Another current
authenticated device of that account can stop the accepted share. That authorized
stop clears only a header derived from that account and session. An old-session
stop must not clear a newer unrelated share. Clearing the current source must not restore an older
label. History load, request acceptance, unblock, and restore must not reconstruct
headers from retained messages. Account-scoped and conversation-scoped derived
caches and ordering state stay outside backup and device sync.

Same-member rekeys and device addition preserve live consent. Removed-device or
otherwise ineligible point sources are pruned without a permanent session stop.
Only a fresh eligible authenticated point can establish another header after
pruning. Explicit stops and block retain tombstones that reject replayed points
and delayed lookups. Unblock must not remove that protection or reconstruct a header.

Migration clears the former global consent and coarse caches. It creates no
broadcast. Already queued MLS ciphertext remains ordered to avoid ratchet gaps;
upgraded recipients consume and ignore legacy locality bodies. Older clients
can retain previously queued or received locality until its existing expiry.

An app that displays derived labels must also display GeoNames attribution and
the CC BY 4.0 license link in its existing location-sharing interface. This does
not require a global setting or extra header text. The UI must preserve the
approximate meaning and must not imply exact municipal membership.
