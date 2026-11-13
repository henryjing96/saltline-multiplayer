# Operator models: sources and licences

The three operator models (`scout.glb`, `diver.glb`, `bulwark.glb`) and their preview images are built
offline with Blender (bpy 4.5) from the assets below. Bodies were generated with MPFB2; clothing was
fitted to them, re-textured (the uniform print is original, the vest texture is re-tinted), decimated
and skinned to a Mixamo-named skeleton. Helmets, headsets, packs, pouches and the carbine are original
geometry. Animations were retargeted onto each skeleton.

| Asset | Author | Licence |
| --- | --- | --- |
| Base mesh, body targets, rig, skins, eyes, eyebrows, ponytail hair | MakeHuman Community (via MPFB2 system assets) | CC0 1.0 |
| Tactical vest (male/female), biker boots (male/female) | Mindfront (Sweden), MakeHuman asset packs Equipment 03 / Shoes 03 | CC BY 4.0 |
| Uniform jacket and trousers meshes (male/female) | elvaerwyn + punkduck, MakeHuman asset pack Suits 03 | CC BY 4.0 |
| Idle, walk, jog, sprint, crouch and death animations | Quaternius, Universal Animation Library (Standard) | CC0 1.0 |
| `three-gltf.js` (GLTFLoader, SkeletonUtils from three.js r180) | three.js authors | MIT, see `THREE-LICENSE.txt` |

CC BY 4.0: https://creativecommons.org/licenses/by/4.0/ · CC0 1.0: https://creativecommons.org/publicdomain/zero/1.0/
Asset packs: https://static.makehumancommunity.org/assets/assetpacks/ · Animations: https://quaternius.itch.io/universal-animation-library

The shipped GLBs are post-processed with glTF-Transform (`tools/compress_operators.sh`): textures resized to 1024 px and re-encoded as WebP,
geometry quantized, animation resampled. The loader needs no extra decoder for these.
