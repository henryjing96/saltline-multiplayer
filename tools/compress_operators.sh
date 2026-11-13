#!/bin/sh
# Shrinks the operator GLBs: WebP textures, quantized geometry, resampled animation.
# Needs Node and `npm i @gltf-transform/cli` in the current directory.
# Usage: compress_operators.sh <in-dir> <out-dir> [max-texture-size, default 2048]
set -e
in=$1; out=$2; size=${3:-2048}; tmp=$(mktemp -d); gt="npx gltf-transform"
for n in scout diver bulwark; do
  $gt dedup "$in/$n.glb" "$tmp/a.glb"
  $gt resample "$tmp/a.glb" "$tmp/b.glb"
  $gt resize "$tmp/b.glb" "$tmp/r.glb" --width "$size" --height "$size"
  $gt webp "$tmp/r.glb" "$tmp/c.glb" --slots "normalTexture" --quality 85
  $gt webp "$tmp/c.glb" "$tmp/d.glb" --quality 80
  $gt quantize "$tmp/d.glb" "$tmp/e.glb" --quantize-position 14 --quantize-normal 10 --quantize-texcoord 12 --quantize-weight 8 --quantization-volume scene
  $gt dedup "$tmp/e.glb" "$tmp/f.glb"
  $gt prune "$tmp/f.glb" "$out/$n.glb" --keep-leaves true --keep-attributes true
done
rm -rf "$tmp"
