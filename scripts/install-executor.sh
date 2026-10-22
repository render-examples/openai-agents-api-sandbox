#!/usr/bin/env bash
set -euo pipefail

# Pinned and verified against `codex exec-server --help` on 2026-10-21.
# npm verifies the registry-provided Subresource Integrity value while installing.
readonly CODEX_VERSION="0.163.0"
readonly CODEX_INTEGRITY="sha512-HNd7vR9oTK6M2ikxFnvNDCdYUgAsyo9VVnd5KnEd2ON0GYI++7MiX9XNPUkhtdgGKFPsWS+CEppQ1UU63uVhUw=="
readonly CODEX_PACKAGE="@openai/codex@${CODEX_VERSION}"

mkdir -p /workspace/output
registry_integrity="$(npm view "${CODEX_PACKAGE}" dist.integrity)"
if [[ "${registry_integrity}" != "${CODEX_INTEGRITY}" ]]; then
  printf 'integrity mismatch for %s\n' "${CODEX_PACKAGE}" >&2
  exit 1
fi

case "$(uname -m)" in
  x86_64)
    platform_package="@openai/codex@${CODEX_VERSION}-linux-x64"
    platform_integrity="sha512-uwRaOsrYogLQhcxAM/GoeWrw0QIWEMRo7c9gM8sKAviVkZQHlu9kRLJ5PkufbV+ABGjyZgIwiFdJ0LCJ0N6e8w=="
    ;;
  aarch64|arm64)
    platform_package="@openai/codex@${CODEX_VERSION}-linux-arm64"
    platform_integrity="sha512-IH2/R+4OarjGvsAf1ll3fdyLwrPgYLl3uzp6u9CyD9sj2Lw+ViDSe3QBZVHdcHJs0eIiZFg6Wprcuy4CRZaUGw=="
    ;;
  *)
    printf 'unsupported sandbox architecture: %s\n' "$(uname -m)" >&2
    exit 1
    ;;
esac

if [[ "$(npm view "${platform_package}" dist.integrity)" != "${platform_integrity}" ]]; then
  printf 'integrity mismatch for %s\n' "${platform_package}" >&2
  exit 1
fi
npm install --global --ignore-scripts=false "${CODEX_PACKAGE}"

installed_version="$(codex --version)"
printf 'installed %s\n' "${installed_version}"
codex exec-server --help >/dev/null
