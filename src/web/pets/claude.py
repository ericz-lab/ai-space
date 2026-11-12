# The panel's built-in Claude desk pet: the little pixel creature, built as a 3D toy in Blender and
# rendered into sprite frames.
#
#   blender --background --factory-startup --python src/web/pets/claude.py -- --out <dir> [--only walk] [--frames 0,3] [--size 384]
#
# One unit is one pixel of the original drawing: a body 13 wide and 7 tall, two slot eyes, an arm stub on
# each side and four legs 3 long. It faces the viewer (-Y) and scuttles sideways (+X), like a crab.
# Nothing is keyframed: `pose()` places every block for one frame and the frame is rendered. The feet are
# planted and travel back exactly as fast as the panel moves the pet, so they do not slide.
# claude.ts builds the sheet (src/web/public/pet-claude.webp); Pet.tsx draws it.
import bpy, bmesh, sys, os, json
from math import sin, cos, pi, radians, atan2, sqrt
from mathutils import Vector, Matrix

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
def arg(name, default=None):
    return argv[argv.index(name) + 1] if name in argv else default

OUT = arg("--out", "/tmp/claude-frames")
ONLY = arg("--only")
FRAMES = [int(x) for x in arg("--frames").split(",")] if arg("--frames") else None
SIZE = int(arg("--size", "384"))
SAVE = arg("--save")

# ---- the sheet's contract: claude.ts reads it with --spec, and the CLAUDE sprite in ../Pet.tsx must say
# the same (pet-claude.test.ts compares them) ----
ANIMS = {
    "walk": {"row": 0, "frames": 8, "ms": 320},
    "sleep": {"row": 1, "frames": 12, "ms": 3600},
    "look": {"row": 2, "frames": 12, "ms": 2880},
    "hop": {"row": 3, "frames": 12, "ms": 900},
    "jump": {"row": 4, "frames": 12, "ms": 720},
}
if "--spec" in argv:
    print("SPEC " + json.dumps(ANIMS))
    sys.exit(0)

# The panel shows a cell `WIDTH_PX` wide and moves the pet SPEED px/s (../Pet.tsx: the sprite's width, SPEED).
WIDTH_PX, SPEED = 80, 55
ORTHO = 23.0                     # units across a cell
CAM_YAW, CAM_ELEV = radians(18), radians(13)
TARGET = Vector((0.4, 0, 9.3))
# Speed along X that looks like SPEED on the page.
WALK_SPEED = SPEED / (WIDTH_PX / ORTHO) / cos(CAM_YAW)

def hexcol(h):
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(((v + 0.055) / 1.055) ** 2.4 if v > 0.04045 else v / 12.92 for v in c) + (1.0,)

# ---- scene ----
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
for engine in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
    try:
        scene.render.engine = engine
        break
    except TypeError:
        pass
scene.render.film_transparent = True
scene.render.resolution_x = scene.render.resolution_y = SIZE
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "Standard"
scene.view_settings.look = "None"
for key, value in (("use_raytracing", True), ("taa_render_samples", 64), ("use_shadows", True)):
    if hasattr(scene.eevee, key):
        setattr(scene.eevee, key, value)
world = bpy.data.worlds.new("w")
scene.world = world
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (1.0, 0.96, 0.93, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.62

cam_data = bpy.data.cameras.new("cam")
cam_data.type = "ORTHO"
cam_data.ortho_scale = ORTHO
cam = bpy.data.objects.new("cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
cam_dir = Vector((sin(CAM_YAW) * cos(CAM_ELEV), -cos(CAM_YAW) * cos(CAM_ELEV), sin(CAM_ELEV)))
cam.location = TARGET + cam_dir * 200
cam.rotation_euler = (-cam_dir).to_track_quat("-Z", "Y").to_euler()
cam_data.clip_end = 1000

def light(name, direction, energy, colour=(1, 1, 1), shadow=True):
    data = bpy.data.lights.new(name, "SUN")
    data.energy, data.color, data.angle, data.use_shadow = energy, colour, radians(18), shadow
    ob = bpy.data.objects.new(name, data)
    scene.collection.objects.link(ob)
    ob.rotation_euler = Vector(direction).to_track_quat("Z", "Y").to_euler()
light("key", (-0.35, -0.75, 1.0), 2.6, (1.0, 0.98, 0.95))
light("rim", (0.8, 0.6, 0.5), 0.9, (1.0, 0.92, 0.85), shadow=False)

def material(name, colour, rough=0.5, coat=0.0, emission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = colour
    b.inputs["Roughness"].default_value = rough
    if coat:
        b.inputs["Coat Weight"].default_value = coat
        b.inputs["Coat Roughness"].default_value = 0.08
    return m
M_BODY = material("body", hexcol("D36B4B"), rough=0.45, coat=0.2)
M_EYE = material("eye", hexcol("120E0C"), rough=0.6)

def shadow_material():
    """A soft dark blob under the pet: opaque nowhere, fading to nothing at its rim."""
    m = bpy.data.materials.new("shadow")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    N, L = nt.nodes.new, nt.links.new
    out, mixs, tr, em = N("ShaderNodeOutputMaterial"), N("ShaderNodeMixShader"), N("ShaderNodeBsdfTransparent"), N("ShaderNodeEmission")
    em.inputs[0].default_value = (0.05, 0.03, 0.02, 1)
    tc, length, ramp, strength = N("ShaderNodeTexCoord"), N("ShaderNodeVectorMath"), N("ShaderNodeMapRange"), N("ShaderNodeValue")
    length.operation = "LENGTH"
    L(tc.outputs["Object"], length.inputs[0])
    ramp.inputs[1].default_value, ramp.inputs[2].default_value = 1.0, 0.25
    ramp.inputs[3].default_value = 0.0
    ramp.interpolation_type = "SMOOTHSTEP"
    L(length.outputs["Value"], ramp.inputs[0])
    strength.label = "strength"
    L(strength.outputs[0], ramp.inputs[4])
    L(ramp.outputs[0], mixs.inputs[0])
    L(tr.outputs[0], mixs.inputs[1])
    L(em.outputs[0], mixs.inputs[2])
    L(mixs.outputs[0], out.inputs[0])
    if hasattr(m, "surface_render_method"):
        m.surface_render_method = "BLENDED"
    else:
        m.blend_method = "BLEND"
    return m, strength
M_SHADOW, SHADOW_STRENGTH = shadow_material()

def block(name, dims, mat, bevel=0.32):
    """A box with rounded edges, centred on its origin."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Diagonal((*dims, 1.0)))
    bmesh.ops.bevel(bm, geom=bm.edges[:], offset=min(bevel, min(dims) * 0.45), segments=4, profile=0.6, affect="EDGES")
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    mod = ob.modifiers.new("normals", "WEIGHTED_NORMAL")
    mod.keep_sharp = False
    return ob

# ---- the creature (rest pose: feet on z = 0, body bottom at z = LEG) ----
BW, BH, BD = 13.0, 7.0, 6.4      # body width, height, depth
LEG = 3.0
BODY = block("body", (BW, BD, BH), M_BODY, 0.55)
EYES = {s: block(f"eye{s}", (1.05, 0.5, 1.95), M_EYE, 0.12) for s in (-1, 1)}
ARMS = {s: block(f"arm{s}", (2.6, 2.3, 2.4), M_BODY, 0.4) for s in (-1, 1)}
# hips in body coordinates (origin: centre of the body's underside): outer legs behind, inner legs in front
HIPS = {("back", -1): Vector((-5.4, 1.15, 0)), ("front", -1): Vector((-3.5, -1.15, 0)),
        ("front", 1): Vector((3.5, -1.15, 0)), ("back", 1): Vector((5.4, 1.15, 0))}
LEGS = {k: block(f"leg-{k[0]}{k[1]}", (1.05, 1.05, 1.0), M_BODY, 0.22) for k in HIPS}
SHADOW = bpy.data.objects.new("shadow", bpy.data.meshes.new("shadow"))
bm = bmesh.new()
bmesh.ops.create_circle(bm, cap_ends=True, segments=48, radius=1.0)
bm.to_mesh(SHADOW.data)
bm.free()
SHADOW.data.materials.append(M_SHADOW)
scene.collection.objects.link(SHADOW)
if hasattr(SHADOW, "visible_shadow"):
    SHADOW.visible_shadow = False

def T(v):
    return Matrix.Translation(Vector(v))
def R(a, axis):
    return Matrix.Rotation(a, 4, axis)
def S(v):
    return Matrix.Diagonal((*v, 1.0))

def pose(x=0.0, lift=0.0, crouch=0.0, yaw=0.0, roll=0.0, pitch=0.0, squash=1.0, feet=None, tuck=0.0,
         arms=(0.0, 0.0), eye=1.0, eye_wide=1.0, look=0.0):
    """Place every block for one frame.
    lift raises the whole body; crouch lowers it onto bent legs; squash scales its height from the underside
    (the width gives). feet maps a leg to its planted point (x offset from its hip, height); a leg without
    one hangs under its hip, pulled up by tuck. arms are the angles the left and right arm are raised.
    eye is how open the eyes are, look shifts them sideways."""
    w = 1 / sqrt(squash)
    B = T((x, 0, LEG + lift - crouch)) @ R(yaw, "Z") @ R(roll, "Y") @ R(pitch, "X")
    Bs = B @ S((w, w, squash))
    BODY.matrix_world = Bs @ T((0, 0, BH / 2))
    for s in (-1, 1):
        closed = eye < 0.3
        EYES[s].matrix_world = Bs @ T((s * 3.75 + look, -BD / 2 + 0.12, 4.45)) @ S((1.55 if closed else 1.0, 1.0, 0.16 if closed else eye * eye_wide))
        raise_ = arms[0] if s < 0 else arms[1]
        # the arm hinges where it meets the body's side
        ARMS[s].matrix_world = Bs @ T((s * (BW / 2 - 0.3), 0, 2.75)) @ R(-s * raise_, "Y") @ T((s * 1.3, 0, 0))
    for key, hip in HIPS.items():
        top = B @ Vector((hip.x * w, hip.y * w, 0.6))            # a little inside the body
        if feet and key in feet:
            fx, fz = feet[key]
            foot = Vector(((B @ hip).x + fx, (B @ hip).y, fz))
        else:
            foot = B @ Vector((hip.x * w, hip.y * w, -(LEG - crouch) * (1 - tuck)))
            foot.z = max(foot.z, 0.0) if lift <= 0.01 else foot.z
        d = top - foot
        length = max(d.length, 0.3)
        rot = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        LEGS[key].matrix_world = T((top + foot) / 2) @ rot @ S((1, 1, length))
    # the shadow shrinks and fades as the pet leaves the ground
    k = 1 / (1 + lift * 0.22)
    SHADOW.matrix_world = T((x, 0.3, 0.02)) @ S((8.6 * k, 4.6 * k, 1))
    SHADOW_STRENGTH.outputs[0].default_value = 0.34 * k

def smooth(u):
    u = max(0.0, min(1.0, u))
    return u * u * (3 - 2 * u)

def bump(t, start, end):
    """0 outside [start, end], a smooth rise and fall inside."""
    return 0.0 if t <= start or t >= end else sin(pi * (t - start) / (end - start)) ** 2

def pose_walk(t):
    """A sideways scuttle. Diagonal pairs of legs move together; a foot is planted for half the cycle and
    travels back at the pet's own speed, then swings forward. The body bobs and rocks, the arms pump."""
    travel = WALK_SPEED * ANIMS["walk"]["ms"] / 1000 / 2
    feet = {}
    for key, phase in ((("front", 1), 0.0), (("back", -1), 0.0), (("back", 1), 0.5), (("front", -1), 0.5)):
        q = (t + phase) % 1.0
        if q < 0.5:
            feet[key] = (travel / 2 - travel * (q / 0.5), 0.0)
        else:
            u = (q - 0.5) / 0.5
            feet[key] = (-travel / 2 + travel * (0.5 - 0.5 * cos(pi * u)), 1.25 * sin(pi * u))
    bob = 0.22 * cos(4 * pi * t)
    pose(lift=0.12 + bob * 0.5, crouch=0.25 - bob * 0.5, roll=radians(3.2) * sin(2 * pi * t), yaw=radians(7), feet=feet,
         arms=(radians(16) * sin(2 * pi * t), radians(16) * sin(2 * pi * t + pi)), look=0.28)

def pose_sleep(t):
    """Asleep: settled on its belly with the legs tucked under, eyes shut, breathing slowly."""
    breath = sin(2 * pi * t)
    pose(crouch=LEG - 0.35, tuck=0.0, squash=0.94 + 0.035 * breath, arms=(radians(-26) + radians(3) * breath, radians(-26) + radians(3) * breath), eye=0.0)

def pose_look(t):
    """Watching: it stands, turns to look one way and then the other, blinks, and drums a foot."""
    turn = radians(20) * (bump(t, 0.08, 0.42) - bump(t, 0.5, 0.86))
    tap = bump((t * 4) % 1.0, 0.0, 0.6) if 0.5 <= t < 1.0 else 0.0
    feet = {("front", 1): (0.0, 0.7 * tap)}
    blink = 0.44 <= t < 0.5 or 0.9 <= t < 0.96
    pose(yaw=turn, squash=1 + 0.012 * sin(4 * pi * t), feet=feet, arms=(radians(6), radians(6) + radians(18) * bump(t, 0.1, 0.4)),
         eye=0.0 if blink else 1.0, look=0.5 * turn / radians(20))

def hop(u, height):
    """One hop over u in 0..1: crouch, leave the ground with arms up, land and squash. Returns pose arguments."""
    if u <= 0 or u >= 1:
        return dict()
    wind, air, land = bump(u, 0.0, 0.3), (sin(pi * (u - 0.2) / 0.55) if 0.2 < u < 0.75 else 0.0), bump(u, 0.68, 1.0)
    return dict(lift=height * air, crouch=0.9 * wind * (1 - air) + 0.7 * land, squash=1 - 0.1 * wind * (1 - air) + 0.09 * air - 0.1 * land,
                tuck=0.35 * air, arms=(radians(62) * smooth(air * 1.6) - radians(12) * land,) * 2)

def pose_hop(t):
    """Two quick hops with the arms thrown up and the eyes wide. Frame 0 is the quiet pose, held between bursts."""
    u = (t - 0.06) / 0.44 if t < 0.52 else (t - 0.52) / 0.44
    kw = hop(u, 2.6)
    kw.setdefault("arms", (radians(6), radians(6)))
    pose(eye_wide=1.0 + 0.22 * (1 if kw.get("lift", 0) > 0.2 else 0), **kw)

def pose_jump(t):
    """A click: one high hop with a full spin."""
    kw = hop(t, 5.2)
    air = smooth((t - 0.2) / 0.55)
    pose(yaw=2 * pi * air, **kw)

POSES = {"walk": pose_walk, "sleep": pose_sleep, "look": pose_look, "hop": pose_hop, "jump": pose_jump}

os.makedirs(OUT, exist_ok=True)
for name, anim in ANIMS.items():
    if ONLY and name != ONLY:
        continue
    for i in range(anim["frames"]):
        if FRAMES is not None and i not in FRAMES:
            continue
        POSES[name](i / anim["frames"])
        scene.render.filepath = os.path.join(OUT, f"{name}-{i:02d}.png")
        bpy.ops.render.render(write_still=True)
if SAVE:
    bpy.ops.wm.save_as_mainfile(filepath=SAVE)
