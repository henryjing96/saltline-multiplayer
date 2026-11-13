import bpy, sys, math
from mathutils import Vector
glb, out = sys.argv[-2], sys.argv[-1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=glb)
arm=[o for o in bpy.context.scene.objects if o.type=='ARMATURE'][0]
for o in bpy.context.scene.objects:
    if o.name.startswith('Far_') or o.name.startswith('Carbine'): o.hide_render = True
sc = bpy.context.scene
sc.render.engine = 'CYCLES'; sc.cycles.samples = 48; sc.cycles.use_denoising = True; sc.render.film_transparent = True
w = bpy.data.worlds.new('w'); sc.world = w; w.use_nodes = True
w.node_tree.nodes['Background'].inputs[0].default_value = (0.5, 0.56, 0.62, 1); w.node_tree.nodes['Background'].inputs[1].default_value = 0.8
for name, energy, rot in (('key', 3.4, (55, 0, 40)), ('rim', 1.6, (60, 0, 200))):
    l = bpy.data.lights.new(name, 'SUN'); l.energy = energy; o = bpy.data.objects.new(name, l); sc.collection.objects.link(o); o.rotation_euler = tuple(math.radians(v) for v in rot)
act = bpy.data.actions['idle']; arm.animation_data_create(); arm.animation_data.action = act
if hasattr(arm.animation_data, 'action_slot') and act.slots: arm.animation_data.action_slot = act.slots[0]
sc.frame_set(10)
cam = bpy.data.cameras.new('cam'); co = bpy.data.objects.new('cam', cam); sc.collection.objects.link(co); sc.camera = co
sc.render.resolution_x = 448; sc.render.resolution_y = 560; cam.lens = 70
H = max((o.matrix_world @ Vector(c)).z for o in sc.objects if o.type=='MESH' and not o.hide_render for c in o.bound_box)
tgt = Vector((0, 0, H * 0.5)); d = Vector((0.45, -1, 0)).normalized()
co.location = tgt + d * H * 2.1 + Vector((0, 0, 0.1)); co.rotation_euler = (tgt - co.location).to_track_quat('-Z', 'Y').to_euler()
sc.render.filepath = out; bpy.ops.render.render(write_still=True)
