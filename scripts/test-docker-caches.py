#!/usr/bin/env python3
"""Check Docker cache and runtime-output contracts without a Docker daemon."""
from pathlib import Path
import re
import shlex

root = Path(__file__).resolve().parents[1]
for service in ('server', 'echo', 'bots', 'web'):
    text = (root / f'deploy/docker/{service}.Dockerfile').read_text()
    logical = text.replace('\\\n', ' ')
    cargo_runs = [line for line in logical.splitlines() if line.startswith('RUN ') and ('cargo ' in line or 'scripts/build-wasm.sh' in line)]
    assert len(cargo_runs) == 1, service
    run = cargo_runs[0]
    for cache_id, target in (
        ('chat-cargo-build-slot', '/var/lock/chat-cargo-build'),
        ('chat-cargo-registry', '/usr/local/cargo/registry'),
        ('chat-cargo-git', '/usr/local/cargo/git'),
        ('chat-cargo-target-rust1.99-bookworm-${TARGETOS}-${TARGETARCH}-${TARGETVARIANT}', '/src/target'),
    ):
        assert f'--mount=type=cache,id={cache_id},target={target},sharing=locked' in run, (service, cache_id)
    for argument in ('TARGETOS', 'TARGETARCH', 'TARGETVARIANT'):
        assert f'ARG {argument}' in text.split('RUN ')[0], (service, argument)
    assert 'CARGO_TARGET_DIR=/src/target' in run, service
    assert 'export CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-$(nproc)}"' in run, service
    assert not re.search(r'COPY --from=\w+ /src/target/', text), service
    if service == 'web':
        assert 'id=chat-wasm-bindgen-tools-rust1.99-bookworm-${TARGETOS}-${TARGETARCH}-${TARGETVARIANT}' in run
        assert 'target=/opt/chat-wasm-tools,sharing=locked' in run
        assert '--root /opt/chat-wasm-tools' in run
        assert 'export PATH="/opt/chat-wasm-tools/bin:$PATH"' in run
        assert '--store-dir /pnpm/store --package-import-method=copy' in logical
        assert 'id=chat-pnpm-v10-${TARGETOS}-${TARGETARCH}-${TARGETVARIANT},target=/pnpm/store,sharing=locked' in logical
        assert 'COPY --from=wasm /src/web/src/core/pkg web/src/core/pkg' in text
        assert 'COPY --from=web /src/web/dist /usr/share/nginx/html' in text
    else:
        packages = ('chat-server', 'chat-admin') if service == 'server' else ('chat-echo',) if service == 'echo' else ('chat-bot',)
        copies = [shlex.split(command) for command in re.findall(r'\bcp\s+([^&;]+)', run)]
        copied_sources = {source for args in copies if args[-1] == '/out/' for source in args[:-1]}
        for package in packages:
            assert f'/src/target/release/{package}' in copied_sources, (service, package)
            assert f'COPY --from=build /out/{package} ' in text, (service, package)
print('PASS: cache IDs, locking, CPU budget, architecture scope, output copies, WASM tool cache, pnpm store')
