"""Test-only provenance model. This is not a deployment control.

HMAC keys and the runner below are synthetic fixtures, not authenticated producers.
There is no Docker daemon or authenticated producer in this model. It must not be
integrated into a live workflow or used as evidence of real build provenance.
The fixture ledger and keys are neither durable nor independent authorities.
The snapshot-to-commit link requires external verification. No real build
attestation exists here.
"""
import hashlib
import hmac
import json
import re

SERVICES = frozenset({'server', 'web', 'echo', 'echo-invite'})
HEX = re.compile(r'^[0-9a-f]{64}$')
COMMIT = re.compile(r'^[0-9a-f]{40}$')


class Rejected(ValueError):
    pass


def require(condition):
    if not condition:
        raise Rejected('invalid or untrusted provenance')


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def sign(key, payload):
    return hmac.new(key, canonical(payload), hashlib.sha256).hexdigest()


def envelope(key, payload):
    return {'payload': payload, 'signature': sign(key, payload)}


def authenticated(item, key):
    require(type(item) is dict and set(item) == {'payload', 'signature'})
    require(type(item['signature']) is str and HEX.fullmatch(item['signature']))
    require(hmac.compare_digest(item['signature'], sign(key, item['payload'])))
    require(type(item['payload']) is dict)
    return item['payload']


def exact(value, keys):
    require(type(value) is dict and set(value) == set(keys))


def digest(value):
    return type(value) is str and bool(HEX.fullmatch(value))


def text(value):
    return type(value) is str and bool(value) and value.strip() == value


def build_spec(spec):
    exact(spec, ('dockerfile', 'platform', 'inputs'))
    require(text(spec['dockerfile']) and text(spec['platform']))
    require(type(spec['inputs']) is dict and bool(spec['inputs']))
    require(all(text(k) and text(v) for k, v in spec['inputs'].items()))


def verify(authority, evidence, plan, tag_lookup, authority_key, producer_key,
           operation, generation, ledger):
    """Verify one fake operation. tag_lookup is a synthetic, operation-local callback.

    The caller supplies operation independently of the signed authority. The plan is
    a list so duplicate service entries cannot be hidden by dictionary conversion.
    """
    require(text(operation) and text(generation) and authority_key != producer_key)
    approved = authenticated(authority, authority_key)
    exact(approved, ('operation', 'generation', 'commit', 'snapshot', 'services'))
    require(approved['operation'] == operation and approved['generation'] == generation)
    require(type(approved['commit']) is str and COMMIT.fullmatch(approved['commit']))
    require(digest(approved['snapshot']))
    specs = approved['services']
    require(type(specs) is dict and set(specs) == SERVICES)
    for spec in specs.values():
        build_spec(spec)
    require(type(evidence) is list and len(evidence) == len(SERVICES))
    require(type(plan) is list and len(plan) == len(SERVICES))
    records = {}
    for item in evidence:
        record = authenticated(item, producer_key)
        exact(record, ('operation', 'generation', 'commit', 'snapshot', 'service', 'dockerfile',
                       'platform', 'inputs', 'image_id', 'tag'))
        service = record['service']
        require(type(service) is str and service in SERVICES and service not in records)
        require(record['operation'] == operation and record['generation'] == generation
                and record['commit'] == approved['commit'])
        require(record['snapshot'] == approved['snapshot'])
        require({k: record[k] for k in ('dockerfile', 'platform', 'inputs')} == specs[service])
        require(type(record['image_id']) is str and record['image_id'].startswith('sha256:')
                and digest(record['image_id'][7:]) and text(record['tag']))
        records[service] = record
    require(set(records) == SERVICES)
    # A single image cannot establish distinct service-specific build claims.
    require(len({r['image_id'] for r in records.values()}) == len(SERVICES))
    seen = set()
    for entry in plan:
        exact(entry, ('service', 'image_id', 'tag'))
        service = entry['service']
        require(type(service) is str and service in SERVICES and service not in seen)
        seen.add(service)
        record = records[service]
        require(entry['image_id'] == record['image_id'] and entry['tag'] == record['tag'])
        # A lookup must produce exactly one full ID; no first-match selection.
        resolved = tag_lookup(entry['tag'])
        require(type(resolved) is list and len(resolved) == 1 and resolved[0] == record['image_id'])
    require(seen == SERVICES)
    # Consume only after all checks. A caller must discard the result if consumption
    # fails or is ambiguous, including when the ledger raised after consuming.
    try:
        consumed = ledger.consume(operation, generation)
    except Exception as exc:
        raise Rejected('invalid or untrusted provenance') from exc
    require(consumed is True)
    # The only usable result contains immutable IDs, not mutable tags.
    return tuple((service, records[service]['image_id']) for service in sorted(SERVICES))


class FixtureLedger:
    """External in-memory fixture, not durable or safe for concurrent use."""
    def __init__(self):
        self.registered = set()
        self.consumed = set()

    def register(self, operation, generation):
        require(text(operation) and text(generation))
        require(all(operation != op and generation != gen for op, gen in self.registered))
        self.registered.add((operation, generation))

    def consume(self, operation, generation):
        pair = (operation, generation)
        if pair not in self.registered or pair in self.consumed:
            return False
        self.consumed.add(pair)
        return True


class FakeRunner:
    """In-memory fixture; no subprocess, Docker, filesystem, or network access."""
    def __init__(self, producer_key):
        self.key = producer_key
        self.tags = {}

    def build(self, approved, service, replies):
        # The fake build reply must identify exactly one full image, never a tag or prefix.
        require(type(replies) is list and len(replies) == 1)
        image_id = replies[0]
        require(type(image_id) is str and image_id.startswith('sha256:') and digest(image_id[7:]))
        require(service in SERVICES and service in approved['services'])
        tag = 'fixture/' + service + ':test'
        self.tags[tag] = [image_id]
        record = {'operation': approved['operation'], 'generation': approved['generation'],
                  'commit': approved['commit'],
                  'snapshot': approved['snapshot'], 'service': service,
                  **approved['services'][service], 'image_id': image_id, 'tag': tag}
        return envelope(self.key, record)

    def lookup(self, tag):
        return self.tags.get(tag, [])
