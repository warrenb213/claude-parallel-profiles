#!/usr/bin/env bash
# Renders docs/diagrams/*.mmd to PNG for the README. VS Code's extension page
# doesn't render Mermaid (GitHub does), and vsce refuses SVG images in a README,
# so the README shows these PNGs; the .mmd files are the source of truth.
#   scripts/render-diagrams.sh            # all
#   scripts/render-diagrams.sh workers    # one, by name
set -euo pipefail
cd "$(dirname "$0")/../docs/diagrams"
names=("$@")
[ ${#names[@]} -eq 0 ] && names=($(ls *.mmd | sed 's/\.mmd$//'))
for n in "${names[@]}"; do
  npx -y -p @mermaid-js/mermaid-cli@11.4.2 mmdc -q -i "$n.mmd" -o "$n.png" -b white -s 2 -w 1100 -c mermaid-config.json
  echo "rendered $n.png"
done
