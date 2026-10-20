#!/usr/bin/env python3
"""Packages this code under another extension identity — the bridge releases
for CPPO's earlier IDs (see src/copies.ts). The code is the same; only the
package.json identity and its `cppo.generation` mark differ, so a bridge steps
aside for any newer copy and its uninstaller keeps the shared data.

    scripts/package-variant.py <publisher> <name> "<display name>" <generation> <version> <out.vsix>
"""
import json, shutil, subprocess, sys

publisher, name, display, generation, version, out = sys.argv[1:7]
orig = open('package.json').read()
pkg = json.loads(orig)
pkg.update(publisher=publisher, name=name, displayName=display, version=version)
pkg['cppo'] = {'generation': int(generation)}
try:
    open('package.json', 'w').write(json.dumps(pkg, indent=2, ensure_ascii=False) + '\n')
    subprocess.run(['npx', 'vsce', 'package', '-o', out], check=True)
finally:
    open('package.json', 'w').write(orig)
