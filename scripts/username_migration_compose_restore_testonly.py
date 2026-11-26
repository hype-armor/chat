"""Synthetic old-runtime reconstruction model. Never use against Docker.

The caller supplies a fake adapter and holds one uninterrupted exclusive fence.
All adapter reads must be authoritative and all journal writes durable. The
independent fence must cover writers, ingress, host ports, administrators, and
all actors that can change the journal or runtime. This module cannot establish
or prove those assumptions. There is deliberately no CLI or Docker adapter.

A verified capture contains the exact normalized, port-free Compose config and
its SHA-256 digest. Every image must be an immutable digest. The fake adapter
must compare runtime container identity, configuration and image identity, not
only service names. It must reject extra containers and ambiguous observations.
"""

import hashlib
import json
import re

operational = False


class ReconstructionError(Exception):
    pass


def _digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=True).encode()).hexdigest()


def _validate_capture(capture):
    if not isinstance(capture, dict) or set(capture) != {'config', 'sha256'}:
        raise ReconstructionError('Invalid capture')
    config = capture['config']
    if not isinstance(config, dict) or set(config) != {'services'}:
        raise ReconstructionError('Unsupported config')
    services = config['services']
    if not isinstance(services, dict) or not services:
        raise ReconstructionError('Missing services')
    for name, service in services.items():
        # A deliberately narrow normalized model, not arbitrary Compose YAML.
        if not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9_-]*', name):
            raise ReconstructionError('Invalid service')
        if not isinstance(service, dict) or set(service) != {'image', 'ports', 'network_mode'}:
            raise ReconstructionError('Unsupported service config')
        if (not isinstance(service['image'], str) or
                not re.fullmatch(r'[^\s@]+@sha256:[0-9a-f]{64}', service['image'])):
            raise ReconstructionError('Image is not pinned')
        if service['ports'] != [] or service['network_mode'] != 'none':
            raise ReconstructionError('Network exposure forbidden')
    if not isinstance(capture['sha256'], str) or capture['sha256'] != _digest(config):
        raise ReconstructionError('Capture digest mismatch')
    return config


def reconstruct_testonly(capture, adapter):
    """Reconcile fake runtime from a verified snapshot under a durable journal.

    Journal is exactly 'restoring' or 'old_ready'. old_ready is the irreversible
    boundary, not a health assertion. Once durable, no restore may ever run.
    The adapter methods used below are test doubles only. Mutations may raise
    after taking effect; the next call reconciles through authoritative reads.
    """
    try:
        config = _validate_capture(capture)

        def fence():
            if adapter.verify_independent_fence(capture['sha256']) is not True:
                raise ReconstructionError('Fence not verified')

        def state():
            value = adapter.read_journal(capture['sha256'])
            if value not in ('restoring', 'old_ready'):
                raise ReconstructionError('Unknown journal state')
            return value

        def check_config():
            # The adapter must verify the capture provenance independently.
            if adapter.verify_capture(capture) is not True:
                raise ReconstructionError('Capture not verified')
            if adapter.normalized_config() != config:
                raise ReconstructionError('Config drift')
            if adapter.verify_images(config) is not True:
                raise ReconstructionError('Image identity drift')

        fence()
        phase = state()
        check_config()
        fence()
        # Inspection returns absent, matching stopped, or matching running.
        # Any mismatch, additional container, or uncertain result must raise.
        runtime = adapter.inspect_runtime(config)
        if runtime not in ('absent', 'stopped', 'running'):
            raise ReconstructionError('Runtime identity drift')
        if phase == 'restoring':
            if runtime == 'running':
                raise ReconstructionError('Runtime started before boundary')
            # Restore must itself be idempotent and inspect its durable intent.
            fence()
            if state() != 'restoring':
                raise ReconstructionError('Journal changed')
            adapter.restore_data()
            fence()
            if state() != 'restoring':
                raise ReconstructionError('Journal changed')
            check_config()
            if adapter.inspect_runtime(config) not in ('absent', 'stopped'):
                raise ReconstructionError('Runtime drift before boundary')
            if adapter.verify_restored_data() is not True:
                raise ReconstructionError('Restore verification failed')
            fence()
            adapter.record_old_ready(capture['sha256'])
        # A lost journal reply is resolved by re-entering this function.
        fence()
        if state() != 'old_ready':
            raise ReconstructionError('Boundary not durable')
        check_config()
        runtime = adapter.inspect_runtime(config)
        if runtime not in ('absent', 'stopped', 'running'):
            raise ReconstructionError('Runtime identity drift')
        if runtime != 'running':
            fence()
            if state() != 'old_ready':
                raise ReconstructionError('Journal changed')
            adapter.start_runtime(config)
        fence()
        check_config()
        if state() != 'old_ready' or adapter.inspect_runtime(config) != 'running':
            raise ReconstructionError('Runtime not reconciled')
        return 'old_ready'
    except ReconstructionError:
        raise
    except Exception:
        raise ReconstructionError('Reconstruction failed; inspect durable state') from None
