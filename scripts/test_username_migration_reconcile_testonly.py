import unittest

from username_migration_reconcile_testonly import ReconcileError, reconcile


class Fake:
    def __init__(self):
        self.containers = []
        self.events = []
        self.behavior = {}
        self.resources_ok = True
        self.fence_ok = True
        self.container_ok = True

    def inspect(self):
        self.events.append(("inspect",))
        return list(self.containers)

    def create(self, service):
        self.events.append(("create", service))
        action = self.behavior.pop(service, "success")
        if action != "before":
            self.containers.append((service, "id-" + service))
        if action in ("before", "lost"):
            raise RuntimeError("fake create failure")

    def resources(self, observed):
        self.events.append(("resources", dict(observed)))
        return self.resources_ok

    def fence(self):
        self.events.append(("fence",))
        return self.fence_ok

    def verify(self, service, identity):
        self.events.append(("verify", service, identity))
        return self.container_ok

    def run(self, expected=("db", "app")):
        return reconcile(expected, inspect=self.inspect, create=self.create,
                         verify_resources=self.resources, verify_container=self.verify,
                         fence=self.fence)


class ReconciliationTests(unittest.TestCase):
    def test_lost_reply_does_not_duplicate_create(self):
        fake = Fake()
        fake.behavior["db"] = "lost"
        self.assertEqual(fake.run(), {"db": "id-db", "app": "id-app"})
        self.assertEqual([e for e in fake.events if e[0] == "create"],
                         [("create", "db"), ("create", "app")])
        self.assertGreater(fake.events.index(("inspect",), fake.events.index(("create", "db")) + 1),
                           fake.events.index(("create", "db")))

    def test_lost_reply_verifies_replacement_before_resource_check(self):
        fake = Fake()
        fake.behavior["db"] = "lost"
        verified = set()
        attachments = set()
        original_create = fake.create

        def create(service):
            try:
                original_create(service)
            finally:
                attachments.update(identity for _, identity in fake.containers)

        def verify(service, identity):
            fake.events.append(("verify", service, identity))
            verified.add((service, identity))
            return True

        def resources(observed):
            fake.events.append(("resources", dict(observed)))
            allowed = {identity for service, identity in observed.items()
                       if (service, identity) in verified}
            return attachments <= allowed

        fake.create, fake.verify, fake.resources = create, verify, resources
        self.assertEqual(fake.run(), {"db": "id-db", "app": "id-app"})
        self.assertEqual([e for e in fake.events if e[0] == "create"],
                         [("create", "db"), ("create", "app")])
        for index, event in enumerate(fake.events):
            if event[0] == "create":
                self.assertEqual(fake.events[index - 1][0], "resources")
                self.assertEqual(fake.events[index - 2], ("fence",))
                prior = [e for e in fake.events[:index - 2] if e[0] == "resources"]
                self.assertEqual(fake.events[index - 1][1], prior[-1][1])
        db_verify = fake.events.index(("verify", "db", "id-db"))
        db_resource = next(i for i, event in enumerate(fake.events)
                           if event == ("resources", {"db": "id-db"}))
        self.assertLess(db_verify, db_resource)

    def test_unexpected_attachment_blocks_create(self):
        fake = Fake()
        fake.containers = [("db", "id-db")]
        fake.resources = lambda observed: {"id-db", "intruder"} <= set(observed.values())
        with self.assertRaisesRegex(ReconcileError, "resource check failed"):
            fake.run()
        self.assertFalse(any(e[0] == "create" for e in fake.events))

    def test_failure_before_effect_inspects_before_retry(self):
        fake = Fake()
        fake.behavior["db"] = "before"
        fake.run(("db",))
        calls = [i for i, e in enumerate(fake.events) if e == ("create", "db")]
        self.assertEqual(len(calls), 2)
        self.assertIn(("inspect",), fake.events[calls[0] + 1:calls[1]])

    def test_drift_after_create_blocks_next_create(self):
        fake = Fake()
        original = fake.create
        def create(service):
            original(service)
            fake.resources_ok = False
        fake.create = create
        with self.assertRaises(ReconcileError):
            fake.run()
        self.assertEqual([e for e in fake.events if e[0] == "create"], [("create", "db")])

    def test_unexpected_duplicate_and_invalid_containers(self):
        for containers in [[("other", "id")], [("db", "id"), ("db", "id2")],
                           [("db", "id"), ("app", "id")]]:
            with self.subTest(containers=containers):
                fake = Fake()
                fake.containers = containers
                with self.assertRaises(ReconcileError):
                    fake.run()
                self.assertFalse(any(e[0] == "create" for e in fake.events))

    def test_changed_or_disappeared_container_rejected(self):
        for replacement in [[("db", "other")], []]:
            with self.subTest(replacement=replacement):
                fake = Fake()
                fake.containers = [("db", "original")]
                def create(service):
                    fake.containers = replacement + [(service, "id-app")]
                fake.create = create
                with self.assertRaises(ReconcileError):
                    fake.run()

    def test_failed_checks_stop_create(self):
        for attribute in ("resources_ok", "fence_ok", "container_ok"):
            fake = Fake()
            fake.containers = [("db", "id-db")]
            setattr(fake, attribute, False)
            with self.subTest(attribute=attribute), self.assertRaises(ReconcileError):
                fake.run()
            self.assertFalse(any(e[0] == "create" for e in fake.events))

    def test_retry_limit(self):
        fake = Fake()
        def fail(service):
            fake.events.append(("create", service))
            raise RuntimeError("no effect")
        fake.create = fail
        with self.assertRaises(ReconcileError):
            fake.run(("db",))
        self.assertEqual(fake.events.count(("create", "db")), 2)

    def test_success_without_container_fails(self):
        fake = Fake()
        fake.create = lambda service: None
        with self.assertRaises(ReconcileError):
            fake.run()


if __name__ == "__main__":
    unittest.main()
