"""Offline synthetic tests; no network, database, object store, or real keys."""
import copy
import unittest
from unittest.mock import patch

import storage_inventory_reconcile_testonly as checker


def page(entries, cursor=None, next_cursor=None):
    return {"authenticated": True, "fence": "fence", "cursor": cursor,
            "next_cursor": next_cursor, "entries": entries}


def row(key, state="live", size=0):
    return {"object_key": key, "state": state, "size_bytes": size}


def obj(key, size=0):
    return {"key": key, "size": size}


class ReconcileTests(unittest.TestCase):
    def check(self, db, s3, before="fence", after="fence"):
        return checker.reconcile(db, s3, before, after)

    def reject(self, db, s3, before="fence", after="fence"):
        with self.assertRaises(checker.ReconcileError) as error:
            self.check(db, s3, before, after)
        self.assertEqual(str(error.exception), "inventory reconciliation rejected")

    def test_empty_and_paginated_match(self):
        self.assertIsNone(self.check([page([])], [page([])]))
        db = [page([row("a", size=0)], next_cursor="1"),
              page([row("b", size=checker.MAX_SIZE_BYTES)], cursor="1")]
        s3 = [page([obj("b", checker.MAX_SIZE_BYTES)], next_cursor="next"),
              page([obj("a")], cursor="next")]
        self.assertIsNone(self.check(db, s3))

    def test_missing_orphan_and_size_mismatch(self):
        self.reject([page([row("a")])], [page([])])
        self.reject([page([])], [page([obj("a")])])
        self.reject([page([row("a", size=1)])], [page([obj("a", 2)])])
        self.reject([page([row("a", "ready")])], [page([])])

    def test_all_other_states_rejected_even_if_present_or_absent(self):
        for state in ("reserved", "writing", "ready", "unknown", "", None, 1):
            for objects in ([], [obj("a")]):
                with self.subTest(state=state, objects=objects):
                    self.reject([page([row("a", state)])], [page(objects)])

    def test_duplicates_across_pages_and_within_page(self):
        self.reject([page([row("a"), row("a", size=1)])], [page([obj("a")])])
        self.reject([page([row("a")], next_cursor="n"), page([row("a")], "n")], [page([obj("a")])])
        self.reject([page([row("a")])], [page([obj("a", 1), obj("a")])])
        self.reject([page([row("a")])], [page([obj("a")], next_cursor="n"), page([obj("a")], "n")])

    def test_pagination_chain(self):
        valid = [page([], next_cursor="n"), page([], "n")]
        for pages in ([], [page([], next_cursor="n")], [page([], "n")],
                      [page([]), page([])], [page([], next_cursor="n"), page([], "x")],
                      [page([], next_cursor="n"), page([], "n", "n"), page([], "n")]):
            self.reject(pages, [page([])])
            self.reject([page([])], pages)
        self.assertIsNone(self.check(valid, [page([])]))

    def test_authentication_and_fence(self):
        for field, value in (("authenticated", False), ("authenticated", 1),
                             ("fence", "changed"), ("fence", "")):
            bad = page([])
            bad[field] = value
            self.reject([bad], [page([])])
            self.reject([page([])], [bad])
        self.reject([page([])], [page([])], after="changed")
        self.reject([page([])], [page([])], before="")

    def test_invalid_sizes(self):
        for size in (-1, checker.MAX_SIZE_BYTES + 1, True, False, None, 1.0, "1", [], {}):
            with self.subTest(size=size):
                self.reject([page([row("sensitive-key", size=size)])], [page([obj("sensitive-key")])])
                self.reject([page([row("sensitive-key")])], [page([obj("sensitive-key", size)])])

    def test_bounds_and_malformed(self):
        for key in ("", "\x00", "x" * (checker.MAX_KEY_BYTES + 1), "é" * 513, "\ud800", None):
            self.reject([page([row(key)])], [page([])])
            self.reject([page([])], [page([obj(key)])])
        for bad in ({}, {"object_key": "a", "state": "live"},
                    {"object_key": "a", "state": "live", "size_bytes": 0, "extra": 1}):
            self.reject([page([bad])], [page([])])
        for bad in ("a", {}, {"key": "a"}, {"key": "a", "size": 0, "extra": 1}):
            self.reject([page([])], [page([bad])])
        extra = copy.deepcopy(page([]))
        extra["extra"] = True
        self.reject([extra], [page([])])
        self.reject([page([], next_cursor="x" * (checker.MAX_TOKEN_BYTES + 1))], [page([])])
        with patch.object(checker, "MAX_ENTRIES", 1):
            self.reject([page([row("a"), row("b")])], [page([])])
            self.reject([page([])], [page([obj("a"), obj("b")])])
        with patch.object(checker, "MAX_PAGES", 1):
            self.reject([page([], next_cursor="n"), page([], "n")], [page([])])


if __name__ == "__main__":
    unittest.main()
