"""Fake-only reconciliation algorithm prototype. Not an operational adapter.

Inspect returns an iterable of (service, immutable container identity) pairs for
all observed containers. verify_resources receives the independently verified
service-to-identity mapping. Verification callbacks return exactly True on success.
Create simulates creation only; it must not start a container. This prototype
cannot establish real-world atomicity, fencing, or authorization.
"""


class ReconcileError(RuntimeError):
    """The observed state or a safety check did not meet the contract."""


def reconcile(expected, *, inspect, create, verify_resources, verify_container, fence):
    """Create missing services in order, with at most one retry after an error.

    A failed create can have taken effect. Always inspect the full state before
    retrying. Identity changes or disappearance after observation fail closed.
    """
    expected = tuple(expected)
    if any(not isinstance(name, str) or not name for name in expected) or len(set(expected)) != len(expected):
        raise ReconcileError("invalid expected services")
    known = {}
    attempts = {}
    pending_success = None
    while True:
        if fence() is not True:
            raise ReconcileError("fence failed")
        observed = {}
        identities = set()
        for service, identity in inspect():
            if service not in expected or service in observed:
                raise ReconcileError("unexpected or duplicate service")
            if not isinstance(identity, str) or not identity or identity in identities:
                raise ReconcileError("invalid or duplicate container identity")
            observed[service] = identity
            identities.add(identity)
        if any(observed.get(service) != identity for service, identity in known.items()):
            raise ReconcileError("observed container changed or disappeared")
        for service, identity in observed.items():
            if verify_container(service, identity) is not True:
                raise ReconcileError("container check failed")
        if verify_resources(dict(observed)) is not True:
            raise ReconcileError("resource check failed")
        known.update(observed)
        if pending_success is not None and pending_success not in observed:
            raise ReconcileError("successful create was not observed")
        pending_success = None
        missing = next((service for service in expected if service not in observed), None)
        if missing is None:
            return dict(observed)
        if attempts.get(missing, 0) >= 2:
            raise ReconcileError("create retry limit reached")
        if fence() is not True:
            raise ReconcileError("fence failed")
        # Recheck the same verified mapping immediately before the next mutation.
        if verify_resources(dict(observed)) is not True:
            raise ReconcileError("resource check failed")
        attempts[missing] = attempts.get(missing, 0) + 1
        try:
            create(missing)
        except Exception:
            # The next iteration checks the fence and complete state before resources.
            continue
        pending_success = missing
