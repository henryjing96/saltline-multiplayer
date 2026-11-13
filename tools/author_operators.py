"""Offline character build. Python 3.11 + bpy 4.5, Pillow, NumPy; see operators/SOURCES.md."""
import argparse, sys, math, os, re
from pathlib import Path
from math import pi, sin, cos
import numpy as np
from PIL import Image, ImageFilter, ImageOps
import bpy, bmesh, addon_utils
from mathutils import Vector
p=argparse.ArgumentParser()
p.add_argument('role',choices=['scout','diver','bulwark']);p.add_argument('--mpfb',type=Path,required=True)
p.add_argument('--assets',type=Path,required=True);p.add_argument('--cache',type=Path,required=True)
p.add_argument('--output',type=Path,required=True);p.add_argument('--anims',type=Path,required=True);args=p.parse_args()
role=args.role; female=role=='scout'; heavy=role=='bulwark'; sex='female' if female else 'male'
assets=args.assets.resolve(); cache=args.cache.resolve()/role; cache.mkdir(parents=True,exist_ok=True)
out=args.output.resolve();out.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(args.mpfb.resolve()/'src'))
# Standalone bpy has no installed extension namespace. Isolate the authoring preferences and caches.
user=cache/'mpfb';user.mkdir(exist_ok=True)
bpy.utils.extension_path_user=lambda *a,**kw:str(user)
addon_utils.enable('mpfb',default_set=True,persistent=False)
from mpfb.services import HumanService, TargetService
bpy.ops.object.select_all(action='SELECT');bpy.ops.object.delete(use_global=False)
rng=np.random.default_rng(24+['scout','diver','bulwark'].index(role))
def source_image(path):
    # the slimmed asset pack stores some source textures as .jpg under the same name
    path=Path(path);return Image.open(str(path if path.exists() else path.with_suffix('.jpg')))
def jpg(path,src,size=2048):
    im=source_image(src).convert('RGB');im.thumbnail((size,size),Image.Resampling.LANCZOS)
    im.save(path,quality=89,subsampling=0)
    return path
def node_material(name,*,color=(.12,.14,.12),diff=None,normal=None,rough=.72,metal=0.,mask=False,roughmap=None):
    m=bpy.data.materials.new(name);m.use_fake_user=True;m.use_nodes=True;nodes=m.node_tree.nodes;links=m.node_tree.links
    bs=nodes.get('Principled BSDF');bs.inputs['Base Color'].default_value=(*color,1);bs.inputs['Roughness'].default_value=rough;bs.inputs['Metallic'].default_value=metal
    def image_node(file,source_space):
        node=nodes.new('ShaderNodeTexImage');node.image=bpy.data.images.load(str(file),check_existing=True)
        node.image.colorspace_settings.name=source_space;return node
    if diff:
        tex=image_node(diff,'sRGB');links.new(tex.outputs['Color'],bs.inputs['Base Color'])
        if mask:
            links.new(tex.outputs['Alpha'],bs.inputs['Alpha'])
            m.surface_render_method='DITHERED';m.use_transparency_overlap=False
            m.alpha_threshold=.44
    if normal:
        tex=image_node(normal,'Non-Color');nm=nodes.new('ShaderNodeNormalMap');nm.inputs['Strength'].default_value=.78
        links.new(tex.outputs['Color'],nm.inputs['Color']);links.new(nm.outputs['Normal'],bs.inputs['Normal'])
    if roughmap:
        tex=image_node(roughmap,'Non-Color');channels=nodes.new('ShaderNodeSeparateColor')
        links.new(tex.outputs['Color'],channels.inputs['Color']);links.new(channels.outputs['Green'],bs.inputs['Roughness'])
        links.new(channels.outputs['Blue'],bs.inputs['Metallic'])
    return m
def textile():
    # Original field-uniform print in UV space, with dye islands, ripstop weave and normal detail.
    n=2048
    def field(k,r):
        a=Image.fromarray(rng.integers(0,256,(k,k),dtype=np.uint8)).resize((n,n),Image.Resampling.BICUBIC)
        return np.asarray(a.filter(ImageFilter.GaussianBlur(r)),dtype=np.float32)/255
    big,med,fine=field(43,1.2),field(111,.65),field(280,.45)
    v=.60*big+.28*med+.12*fine
    palette=([[64,70,59],[86,90,70],[109,109,84],[56,62,53],[132,124,95]] if female else
             [[70,71,58],[91,91,70],[121,111,86],[66,64,50],[142,132,100]] if not heavy else
             [[51,57,58],[64,71,71],[79,85,81],[43,48,48],[93,97,90]])
    stripes=np.digitize(v,[.31,.45,.59,.70]);rgb=np.array(palette,dtype=np.float32)[stripes]
    y,x=np.ogrid[:n,:n]
    grain=(np.sin(x*np.pi/2)*np.cos(y*np.pi/2)*2.1+(x%23==0)*2+(y%21==0)*2 +rng.normal(0,1.35,(n,n)))
    rgb=np.uint8(np.clip(rgb+grain[:,:,None]+(fine[:,:,None]-.5)*6,0,255));Image.fromarray(rgb).save(cache/'cloth.jpg',quality=88)
    h=(.42*np.cos(x*np.pi/2)+.35*np.cos(y*np.pi/2)+.7*(x%23==0)+.65*(y%21==0)).astype('f')
    dy,dx=np.gradient(h);nm=np.stack([-dx*.13,-dy*.13,np.ones_like(h)],axis=-1);nm/=np.linalg.norm(nm,axis=-1,keepdims=True)
    Image.fromarray(np.uint8(127.5+127.5*nm)).resize((1024,1024)).save(cache/'weave.png')
    return node_material('Ripstop',diff=cache/'cloth.jpg',normal=cache/'weave.png',rough=.85)
def asset_image(folder,pattern):
    return next((q for q in folder.glob(pattern) if not q.name.startswith('.')),None)
cloth=textile()
vestdir=assets/'clothes'/('mindfront_tactical_vest_'+sex);bootdir=assets/'clothes'/('mindfront_shoes_biker_boots_'+sex)
vest_base=source_image(vestdir/'Tactical_Vest.png').convert('RGB').resize((2048,2048),Image.Resampling.LANCZOS)
shade=np.asarray(vest_base,dtype='f')
tint=([.85,.99,.94] if female else [1.12,1.02,.88] if not heavy else [.63,.72,.83])
Image.fromarray(np.uint8(np.clip(shade*np.array(tint),0,255))).save(cache/'carrier.jpg',quality=90)
jpg(cache/'carrier-normal.jpg',vestdir/'Tactical_Vest_NRM.png',2048)
spec=np.asarray(source_image(vestdir/'Tactical_Vest_SPEC.png').convert('L').resize((1024,1024)),dtype=float)/255
orm=np.empty((*spec.shape,3),np.uint8);orm[:,:,0]=255;orm[:,:,1]=(223-103*spec).astype('B');orm[:,:,2]=(12*spec).astype('B')
Image.fromarray(orm).save(cache/'carrier-orm.png')
carrier=node_material('WovenCarrier',diff=cache/'carrier.jpg',normal=cache/'carrier-normal.jpg',roughmap=cache/'carrier-orm.png')
jpg(cache/'boot.jpg',bootdir/'Shoes_Biker_Boots.png',1024);jpg(cache/'boot-normal.jpg',bootdir/'Shoes_Biker_Boots_NRM.png',1024)
bootmat=node_material('BootLeather',diff=cache/'boot.jpg',normal=cache/'boot-normal.jpg',rough=.52)
skin_name='young_asian_female' if female else 'young_african_male' if not heavy else 'young_caucasian_male'
skin_img=next(q for q in sorted((assets/'skins'/skin_name).iterdir()) if q.suffix in('.png','.jpg'))
# Crop skin later to the UVs of the visible face/neck; covered torso textures do not ship.
skinmat=node_material('Skin',rough=.55)
_e=Image.open(assets/'eyes/materials/brown_eye.png').convert('RGBA');_bg=Image.new('RGBA',_e.size,(226,220,214,255));_bg.alpha_composite(_e)
_bg.convert('RGB').resize((256,256),Image.Resampling.LANCZOS).save(cache/'eyes.jpg',quality=92)
eyes=node_material('Iris',diff=cache/'eyes.jpg',rough=.29)
def alpha_texture(file,name,dim):
    im=Image.open(file).convert('RGBA');im.thumbnail((dim,dim),Image.Resampling.LANCZOS);dest=cache/(name+'.png');im.save(dest)
    return node_material(name,diff=dest,mask=True,rough=.83)
brows=alpha_texture(assets/'eyebrows/eyebrow001/eyebrow001.png','Brows',512)
gloves=node_material('PatrolGloves',color=(.039,.045,.04),rough=.72)
settings=TargetService.get_default_macro_info_dict()
settings.update(gender=0.0 if female else 1.,age=.47 if female else .53 if not heavy else .59,
    muscle=.65 if female else .73 if not heavy else .82,weight=.48 if female else .53 if not heavy else .64,
    height=.58 if female else .60 if not heavy else .65,proportions=.58)
settings['race']={'asian':.88 if female else .04,'african':.04 if female or heavy else .91,'caucasian':.08 if female else .92 if heavy else .05}
body=HumanService.create_human(macro_detail_dict=settings);rig=HumanService.add_builtin_rig(body,'mixamo')
rig.name='OperatorRig';body.name='Skin';head=rig.data.bones['mixamorig:Head'];ztop=head.tail_local.z
def outfit(rel,mat,name,typ='Clothes'):
    directory=assets/rel;file=next(directory.glob('*.mhclo'))
    o=HumanService.add_mhclo_asset(str(file),body,asset_type=typ,subdiv_levels=0,material_type='NONE',set_up_rigging=True,interpolate_weights=True,import_subrig=False,import_weights=True)
    o.name=name;return o,mat
parts=[(body,skinmat),outfit('eyes/low-poly',eyes,'Eyes','Eyes'),outfit('eyebrows/eyebrow001',brows,'Eyebrows','Eyebrows'),
    outfit('clothes/elvs_emt_uniform_jacket_'+sex,cloth,'FieldJacket'),outfit('clothes/elvs_emt_uniform_pants_'+sex,cloth,'FieldPants'),
    outfit('clothes/mindfront_shoes_biker_boots_'+sex,bootmat,'Boots'),outfit('clothes/mindfront_tactical_vest_'+sex,carrier,'Carrier')]
if female:
    hairdir=assets/'hair/ponytail01';parts.append(outfit('hair/ponytail01',alpha_texture(hairdir/'ponytail01_diffuse.png','Hair',1024),'TiedHair','Hair'))

def select(o):
    bpy.ops.object.select_all(action='DESELECT');o.select_set(True);bpy.context.view_layer.objects.active=o
def bind(o):
    world=o.matrix_world.copy();o.parent=rig;o.matrix_world=world
    mod=o.modifiers.new('Deform','ARMATURE');mod.object=rig
def freeze(o,material):
    for m in o.modifiers:
        if m.type in ['ARMATURE','SUBSURF']:m.show_viewport=False
    bpy.context.view_layer.update();dg=bpy.context.evaluated_depsgraph_get()
    mesh=bpy.data.meshes.new_from_object(o.evaluated_get(dg),preserve_all_data_layers=True,depsgraph=dg)
    o.modifiers.clear();o.data=mesh;mesh.materials.clear();mesh.materials.append(material)
    for face in mesh.polygons:face.material_index=0;face.use_smooth=True
    if o==body:
        # Keep the face, neck and hands. Equipment covers the rest, including the proxy helpers.
        threshold=rig.data.bones['mixamorig:Neck'].head_local.z-.046
        hands={g.index for g in o.vertex_groups if 'Hand' in g.name and 'mixamorig:' in g.name}
        bm=bmesh.new();bm.from_mesh(mesh);layer=bm.verts.layers.deform.active
        hidden=[v for v in bm.verts if v.co.z<threshold and sum(w for k,w in v[layer].items() if k in hands)<.08]
        bmesh.ops.delete(bm,geom=hidden,context='VERTS');bm.to_mesh(mesh);bm.free();mesh.update()
        mesh.materials.append(gloves)
        for f in mesh.polygons:
            if f.center.z < threshold: f.material_index=1
        uv=mesh.uv_layers.active.data
        skinloops=[li for f in mesh.polygons if f.material_index==0 for li in f.loop_indices]
        coords=np.array([uv[i].uv[:] for i in skinloops]);lo=np.maximum(np.min(coords,axis=0)-.006,0);hi=np.minimum(np.max(coords,axis=0)+.006,1)
        im=Image.open(skin_img).convert('RGB');w,h=im.size
        box=(int(lo[0]*w),int((1-hi[1])*h),int(np.ceil(hi[0]*w)),int(np.ceil((1-lo[1])*h)))
        im=im.crop(box);im.thumbnail((2048,2048),Image.Resampling.LANCZOS);im.save(cache/'face.jpg',quality=94,subsampling=0)
        for li in set(skinloops):
            u,v=uv[li].uv[:];uv[li].uv=((u*w-box[0])/(box[2]-box[0]),((v-1)*h+box[3])/(box[3]-box[1]))
        tex=material.node_tree.nodes.new('ShaderNodeTexImage');tex.image=bpy.data.images.load(str(cache/'face.jpg'))
        material.node_tree.links.new(tex.outputs['Color'],material.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
    if o.name=='Carrier':
        for v in mesh.vertices:v.co+=v.normal*.004
    bind(o)
    print('MESH',o.name,len(mesh.polygons),len(mesh.vertices),flush=True)
for o,m in parts: freeze(o,m)

# Rigid kit is batched with per-vertex base color and skin weights to its supporting bone.
gear_mat=node_material('EquipmentWebbing',rough=.81);metal_mat=node_material('EquipmentAlloy',rough=.45,metal=.49)
for mat in (gear_mat,metal_mat):
    vc=mat.node_tree.nodes.new('ShaderNodeVertexColor');vc.layer_name='KitColor'
    mat.node_tree.links.new(vc.outputs['Color'],mat.node_tree.nodes.get('Principled BSDF').inputs['Base Color'])
hardparts=[];gunparts=[]
def meshpart(o,color,bone='Spine2',metal=False,gun=False):
    select(o);bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    m=o.data; m.materials.clear();m.materials.append(metal_mat if metal else gear_mat)
    ca=m.color_attributes.new(name='KitColor',type='BYTE_COLOR',domain='CORNER')
    for c in ca.data:c.color_srgb=(*color,1)
    if not gun:
        o.vertex_groups.new(name='mixamorig:'+bone).add(range(len(m.vertices)),1.,'REPLACE')
    (gunparts if gun else hardparts).append(o)
    return o
olive=(.31,.335,.267) if female else (.43,.405,.31) if not heavy else (.258,.29,.292)
black=(.145,.16,.161); edge=(.28,.30,.288);sand=(.51,.49,.404)
def block(at,size,col,bone='Spine2',bevel=.008,metal=False,gun=False,rotation=None):
    bpy.ops.mesh.primitive_cube_add(size=1,location=at);o=bpy.context.object;o.dimensions=size
    select(o);bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if rotation:o.rotation_euler=rotation
    if bevel:
        m=o.modifiers.new('Edge','BEVEL');m.width=min(bevel,min(size)*.35);m.segments=2;bpy.ops.object.modifier_apply(modifier=m.name)
        n=o.modifiers.new('Normals','WEIGHTED_NORMAL');bpy.ops.object.modifier_apply(modifier=n.name)
    return meshpart(o,col,bone,metal,gun)
def tube(a,b,r,col,bone='Spine2',metal=False,gun=False,r2=None,seg=12):
    a,b=Vector(a),Vector(b);axis=b-a
    bpy.ops.mesh.primitive_cone_add(vertices=seg,radius1=r,radius2=r if r2 is None else r2,depth=axis.length,location=(a+b)/2)
    o=bpy.context.object;o.rotation_euler=axis.to_track_quat('Z','Y').to_euler()
    for f in o.data.polygons:f.use_smooth=len(f.vertices)==4
    return meshpart(o,col,bone,metal,gun)
def wire(pts,r,col,bone='Spine2',gun=False):
    for a,b in zip(pts,pts[1:]):tube(a,b,r,col,bone,gun=gun,seg=7)
def ell(at,rad,col,bone='Head',metal=False):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20,ring_count=12,location=at);o=bpy.context.object;o.scale=rad
    for f in o.data.polygons:f.use_smooth=True
    return meshpart(o,col,bone,metal)
hx,hy,_=head.head_local; rim=ztop-.135; ear=ztop-.135; width=.096 if female else .103
# Molded ballistic shells have a raised brow and a deeper occipital lip, open around the ears.
if not female:
    vs=[];fs=[];rows=11;seg=40
    for k in range(rows+1):
        for j in range(seg):
            a=2*pi*j/seg
            limit=1.68+.25*cos(a)-.26*(abs(sin(a))**5)
            q=.012+(limit-.012)*k/rows
            vs.append((hx+sin(a)*sin(q)*(width+.018),hy+cos(a)*sin(q)*.143,ztop-.089+cos(q)*.112))
    for k in range(rows):
        for j in range(seg):
            a=k*seg+j;b=k*seg+(j+1)%seg;fs.append((a,b,b+seg,a+seg))
    me=bpy.data.meshes.new('HelmetShell');me.from_pydata(vs,[],fs);me.update();o=bpy.data.objects.new('Shell',me);bpy.context.collection.objects.link(o)
    for f in me.polygons:f.use_smooth=True
    meshpart(o,olive,'Head')
    ring=vs[-seg:];wire(ring+[ring[0]],.004,black,'Head')
    block((hx,hy-.136,ztop-.078),(.060,.014,.071),black,'Head',metal=True)
    for s in [-1,1]:
        block((hx+s*.017,hy-.146,ztop-.070),(.008,.011,.035),edge,'Head',.002,True)
        block((hx+s*(width+.018),hy+.012,ztop-.099),(.012,.117,.019),black,'Head',.004,True)
        for y in [-.031,0,.03]:ell((hx+s*(width+.025),hy+y,ztop-.098),(.004,.005,.005),sand,'Head',True)
else:
    pts=[(hx+(width+.008)*sin(a),hy+.018,ear+.139*cos(a)) for a in np.linspace(-pi/2,pi/2,16)]
    wire(pts,.012,black,'Head')
for s in [-1,1]:
    ell((hx+s*width,hy+.005,ear),(.024,.042,.054),black)
    block((hx+s*(width+.014),hy+.004,ear),(.027,.063,.079),olive,'Head',.012)
    tube((hx+s*(width+.02),hy,ear+.035),(hx+s*(width+.014),hy+.015,ear+.082),.0045,edge,'Head',True)
wire([(hx-width-.018,hy-.006,ear-.013),(hx-width-.021,hy-.072,ear-.035),(hx-.055,hy-.108,ear-.055),(hx-.027,hy-.118,ear-.061)],.0035,black,'Head')
ell((hx-.031,hy-.117,ear-.059),(.016,.009,.008),black)
# MOLLE pack, compression straps, radio and detachable magazines.
ch=rig.data.bones['mixamorig:Spine2'].head_local; x,y,z=ch
bw=.212 if female else .266 if heavy else .234;dz=.254 if female else .315
pack_y=y+.155
block((x,pack_y,z+.052),(bw,.126,dz),olive,bevel=.036)
block((x,pack_y+.067,z+.04),(bw*.83,.036,dz*.70),olive,bevel=.015)
for j in range(4):
    for s in [-1,0,1]:block((x+s*bw*.265,pack_y+.089,z-.025+j*.036),(bw*.23,.008,.015),black if heavy else edge,bevel=.003)
for s in [-1,1]:
    block((x+s*bw*.36,pack_y+.066,z+.06),(.019,.023,dz*.91),black,bevel=.004)
    block((x+s*bw*.36,pack_y+.085,z+.084),(.026,.012,.029),edge,bevel=.004,metal=True)
# Chest pouches, elastic retainers and closures.
for i in range(2 if female else 3):
    xx=x+(i-(.5 if female else 1))*.064
    block((xx,y-.131,z-.021),(.058,.052,.117),olive,bevel=.011)
    block((xx,y-.132,z+.045),(.048,.029,.026),black,bevel=.004,metal=True)
    wire([(xx-.024,y-.149,z+.029),(xx,y-.154,z+.059),(xx+.024,y-.149,z+.029)],.003,edge)
block((x-.133,y-.083,z+.073),(.052,.04,.078),black,bevel=.005)
if heavy:
    for s,side in [(-1,'Right'),(1,'Left')]:
        shoulder=rig.data.bones['mixamorig:'+side+'Arm'].head_local
        ell(tuple(shoulder+Vector((s*.04,0,-.019))),(.080,.104,.070),olive,side+'Arm',True)
        knee=rig.data.bones['mixamorig:'+side+'Leg'].head_local
        ell(tuple(knee+Vector((0,-.052,-.024))),(.071,.040,.091),black,side+'Leg')
        block(tuple(knee+Vector((0,-.081,-.023))),(.097,.021,.115),edge,side+'Leg',.014,True)
    tube((-.102,pack_y+.095,z-.151),(.11,pack_y+.101,z+.32),.014,black)
    tube((.101,pack_y+.101,z+.30),(.137,pack_y+.10,z+.368),.018,edge,metal=True,r2=.010)
    block((.129,pack_y+.10,z+.358),(.072,.028,.031),edge,bevel=.006,metal=True,rotation=(0,-.32,0))
    for v in [-.06,.075]:block((v,pack_y+.108,z+.02+v*2),(.063,.022,.025),olive)
# Carbine rests along Blender -Y. Pivot is the shoulder stock; sockets are exported with the mesh.
gunZ=0
def gunblock(at,size,col,bevel=.005,rot=None):return block(at,size,col,bevel=bevel,metal=True,gun=True,rotation=rot)
def gunrod(a,b,r,col,r2=None):return tube(a,b,r,col,metal=True,gun=True,r2=r2)
gunblock((0,-.083,-.014),(.047,.172,.074),black,.009)
gunblock((0,-.012,-.017),(.057,.020,.103),edge,.006)
gunrod((0,-.139,.006),(0,-.23,.006),.021,edge)
gunblock((0,-.27,.008),(.062,.162,.073),black)
gunblock((0,-.410,.012),(.055,.235,.057),edge)
for i in range(10):gunblock((0,-.182-i*.032,.049),(.045,.014,.011),black,.001)
for s in [-1,1]:
    for i in range(5):gunblock((s*.027,-.335-i*.036,.009),(.003,.022,.011),black,.002)
gunrod((0,-.518,.013),(0,-.651,.013),.014,edge)
gunrod((0,-.646,.013),(0,-.715,.013),.021,black)
gunrod((0,-.714,.013),(0,-.717,.013),.012,(.03,.035,.033))
gunblock((0,-.291,-.089),(.037,.071,.146),edge,.006,(-.15,0,0))
gunblock((0,-.207,-.07),(.032,.035,.097),black,.008,(-.29,0,0))
wire([(-.007,-.218,-.045),(-.007,-.224,-.064),(-.007,-.258,-.064),(-.007,-.266,-.032)],.0035,edge,gun=True)
gunblock((0,-.251,.065),(.038,.044,.031),black,.004)
gunrod((0,-.213,.087),(0,-.293,.087),.026,black)
gunrod((0,-.292,.087),(0,-.295,.087),.018,(.19,.36,.38))
# Flat two-point sling with attached swivel ends.
strap_pts=[(.027,-.054,-.012),(.034,-.111,-.075),(.052,-.208,-.131),(.059,-.337,-.137),(.042,-.459,-.073),(.031,-.511,.005)]
for a,b in zip(strap_pts,strap_pts[1:]):
    v=Vector(b)-Vector(a);gunblock(tuple((Vector(a)+Vector(b))*.5),(.022,.004,v.length+.002),olive,.001,v.to_track_quat('Z','X').to_euler())
def join_batch(group,name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in group:o.select_set(True)
    bpy.context.view_layer.objects.active=group[0];bpy.ops.object.join();o=bpy.context.object;o.name=name;return o
kit=join_batch(hardparts,'Equipment');bind(kit);parts.append((kit,None))
rifle=join_batch(gunparts,'Carbine')
for name,co in [('Muzzle',(0,-.718,.013)),('RightGrip',(0,-.202,-.055)),('LeftGrip',(0,-.434,-.015))]:
    e=bpy.data.objects.new(name,None);bpy.context.collection.objects.link(e);e.parent=rifle;e.location=co
# Authoring mesh and armature names remain stable between all three outfits.
for bone in rig.data.bones:
    bone.name=bone.name.replace('mixamorig:','')
# Blender updates vertex-group names for objects using this armature; also handle imported residual groups.
for o,_ in parts:
    for vg in o.vertex_groups:
        if vg.name.startswith('mixamorig:'):vg.name=vg.name.replace('mixamorig:','')
def simplify(obj,ratio):
    if ratio>=.997:return
    select(obj);mod=obj.modifiers.new('Game topology','DECIMATE');mod.ratio=ratio
    obj.modifiers.move(len(obj.modifiers)-1,0);bpy.ops.object.modifier_apply(modifier=mod.name)
def tris(obj):return sum(len(p.vertices)-2 for p in obj.data.polygons)
# Keep the eyes/brows intact. Allocate most of the near-detail budget to the face and sewn equipment.
before=sum(tris(o) for o,_ in parts);editable=sum(tris(o) for o,_ in parts if tris(o)>1000)
near_ratio=min(1,max(.18,(39500-tris(rifle)-(before-editable))/max(1,editable)))
for obj,_ in parts:
    name=obj.name
    if tris(obj)>1000:simplify(obj,near_ratio)
    obj.name='Near_'+name
    low=obj.copy();low.data=obj.data.copy();bpy.context.collection.objects.link(low);low.name='Far_'+name
    if tris(low)>100:simplify(low,.26)
    low.hide_render=False

# ---- Locomotion: retarget the CC0 clips onto this rig (world-space deltas, limbs aligned by rest direction).
from mathutils import Quaternion
CLIPS=[('Idle_Loop','idle'),('Walk_Loop','walk'),('Jog_Fwd_Loop','jog'),('Sprint_Loop','sprint'),
       ('Crouch_Idle_Loop','crouch_idle'),('Crouch_Fwd_Loop','crouch_walk'),('Death01','down')]
MAP=[('pelvis','Hips'),('spine_01','Spine'),('spine_02','Spine1'),('spine_03','Spine2'),('neck_01','Neck'),('Head','Head')]
for s_,T_ in (('l','Left'),('r','Right')):
    MAP+=[('clavicle_'+s_,T_+'Shoulder'),('upperarm_'+s_,T_+'Arm'),('lowerarm_'+s_,T_+'ForeArm'),('hand_'+s_,T_+'Hand'),
          ('thigh_'+s_,T_+'UpLeg'),('calf_'+s_,T_+'Leg'),('foot_'+s_,T_+'Foot'),('ball_'+s_,T_+'ToeBase')]
bpy.ops.object.select_all(action='DESELECT')
bpy.ops.import_scene.gltf(filepath=str(args.anims.resolve()))
imported=list(bpy.context.selected_objects);src=next(o for o in imported if o.type=='ARMATURE')
sc=bpy.context.scene;sc.render.fps=24
info=[]
for sn,tn in MAP:
    sb=src.data.bones[sn];tb=rig.data.bones[tn]
    Rs0=sb.matrix_local.to_quaternion();Rt0=tb.matrix_local.to_quaternion()
    if sn.split('_')[0] in ('thigh','calf','upperarm','lowerarm','clavicle'):
        A=(sb.tail_local-sb.head_local).normalized().rotation_difference((tb.tail_local-tb.head_local).normalized())
    else:A=Quaternion()
    par=tb.parent.name if tb.parent else None
    info.append((sn,tn,Rs0.inverted(),A.inverted()@Rt0,Rt0,par))
rest={tn:Rt0 for _,tn,_,_,Rt0,_ in info}
shb=src.data.bones['pelvis'];thb=rig.data.bones['Hips'];hipscale=thb.head_local.z/shb.head_local.z
for pb in rig.pose.bones:pb.rotation_mode='QUATERNION'
rig.animation_data_create();src.animation_data_create()
for sname,oname in CLIPS:
    act=bpy.data.actions[sname];src.animation_data.action=act
    if hasattr(src.animation_data,'action_slot') and act.slots:src.animation_data.action_slot=act.slots[0]
    new=bpy.data.actions.new(oname);rig.animation_data.action=new
    f0,f1=int(act.frame_range[0]),int(act.frame_range[1]);prev={}
    for f in range(f0,f1+1):
        sc.frame_set(f);cur={}
        for sn,tn,Rs0i,K,Rt0,par in info:
            spb=src.pose.bones[sn];Rt=(spb.matrix.to_quaternion()@Rs0i)@K;cur[tn]=Rt
            base=(cur[par]@rest[par].inverted()@Rt0) if par else Rt0
            q=base.inverted()@Rt
            if tn in prev and prev[tn].dot(q)<0:q.negate()
            prev[tn]=q.copy();pb=rig.pose.bones[tn];pb.rotation_quaternion=q
            pb.keyframe_insert('rotation_quaternion',frame=f-f0)
            if tn=='Hips':
                d=(spb.matrix.translation-shb.head_local)*hipscale
                pb.location=Rt0.inverted()@d;pb.keyframe_insert('location',frame=f-f0)
    track=rig.animation_data.nla_tracks.new();track.name=oname;track.strips.new(oname,0,new);rig.animation_data.action=None
    print('CLIP',oname,f1-f0+1,flush=True)
for pb in rig.pose.bones:pb.rotation_quaternion=(1,0,0,0);pb.location=(0,0,0)
for o in imported:bpy.data.objects.remove(o,do_unlink=True)
sc.frame_set(0)
# Export rifle at the origin as a separate rigid subtree. The client attaches it to the chest pose.
bpy.ops.object.select_all(action='DESELECT')
for obj in bpy.context.scene.objects:
    if obj.type in ('MESH','ARMATURE','EMPTY'):obj.select_set(True)
bpy.context.view_layer.objects.active=rig
bpy.ops.export_scene.gltf(filepath=str(out/(role+'.glb')),use_selection=True,export_format='GLB',export_animations=True,export_animation_mode='NLA_TRACKS',export_force_sampling=True,export_optimize_animation_size=False,export_anim_slide_to_zero=True,
    export_morph=False,export_extras=False,export_image_format='AUTO',export_yup=True,export_all_influences=False,
    export_vertex_color='MATERIAL',export_attributes=False)
print('DONE',role,'near tris',sum(tris(o) for o,_ in parts)+tris(rifle),'far tris',sum(tris(o) for o in bpy.context.scene.objects if o.name.startswith('Far_'))+tris(rifle),'height',ztop,flush=True)
