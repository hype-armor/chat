import unittest
from unittest import mock

import username_migration_docker_pg_validate as validation


class DisabledValidationTests(unittest.TestCase):
    def setUp(self):
        self.config = dict(operation='operation_123456789', source_volume='source',
                           validation_volume='validation', image='sha256:' + 'a' * 64,
                           role='chat', database='chatdb')

    def test_outline_is_isolated_and_pinned(self):
        volume, container, restore = validation.disabled_command_plan(**self.config)
        self.assertIn('validation', volume)
        self.assertIn('none', container)
        self.assertIn('POSTGRES_HOST_AUTH_METHOD=trust', container)
        self.assertIn(self.config['image'], container)
        self.assertIn('--exit-on-error', restore)
        self.assertIn('--create', restore)
        self.assertIn('<verified-container-id>', restore)

    def test_rejects_source_volume_and_unpinned_image(self):
        for changes in ({'validation_volume': 'source'}, {'image': 'postgres:latest'},
                        {'role': 'x;DROP'}, {'database': 'postgres'}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validation.disabled_command_plan(**(self.config | changes))

    def test_validation_never_runs_commands_or_persists_evidence(self):
        with mock.patch('subprocess.run') as run, mock.patch('os.open') as open_file:
            with self.assertRaises(validation.ValidationUnsupported):
                validation.validate(**self.config)
            run.assert_not_called()
            open_file.assert_not_called()


if __name__ == '__main__':
    unittest.main()
