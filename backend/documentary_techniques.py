"""Shared catalog of documentary shot/editing techniques - a shot-level
stylistic axis independent of narrative arc *structure*
(narrative_arc_llm.py's ARC_TEMPLATES) and of documentary *mode*
(documentary_modes.py). These are the concrete techniques the presenter can
select or drag onto a scene, and that the moodboard distillation
(narrative_arc_llm.distill_from_moodboard) may suggest from its analysis of
the reference documentaries. This module holds only the structural/display
data; the free-text keys are what get forwarded into shot/cutaway/storyboard
generation as a "favor these techniques" hint (see server.py's
_parse_techniques and the *_llm.py techniques params).

Kept in sync by convention with js/paper-extract.js's DOCUMENTARY_TECHNIQUES -
same convention as documentary_modes.py's DOCUMENTARY_MODES and
narrative_arc_llm.py's ARC_TEMPLATES. The keys are the exact human-readable
strings the frontend uses (so no key<->label mapping layer is needed).
"""

DOCUMENTARY_TECHNIQUES = [
    {
        'key': 'Interview/direct address',
        'label': 'Interview/direct address',
        'description': 'A subject or narrator speaks straight to camera - talking-head framing, eye contact with the viewer.',
        'narrative_operations': [
            'Establish perspective',
            'Provide testimony',
            'Explain or interpret',
            'Build credibility',
            'Create intimacy',
        ],
    },
    {
        'key': 'Montage',
        'label': 'Montage',
        'description': 'A rapid sequence of shots compressing time or building an idea through juxtaposition and rhythm.',
        'narrative_operations': [
            'Compress time',
            'Accumulate evidence',
            'Establish pattern',
            'Show repetition',
            'Build momentum',
        ],
    },
    {
        'key': 'Split-screen juxtaposition',
        'label': 'Split-screen juxtaposition',
        'description': 'Two or more images share the frame at once, inviting a direct visual comparison or contrast.',
        'narrative_operations': [
            'Compare',
            'Contrast',
            'Show simultaneity',
            'Reveal discrepancy',
            'Establish relationship',
        ],
    },
    {
        'key': 'Time-lapse',
        'label': 'Time-lapse',
        'description': 'Long spans of time sped up into a short shot - process, change, or scale made visible.',
        'narrative_operations': [
            'Compress time',
            'Show change',
            'Reveal process',
            'Reveal temporal pattern',
            'Convey scale',
        ],
    },
    {
        'key': 'Observational sequence',
        'label': 'Observational sequence',
        'description': 'The camera watches an activity unfold with minimal intervention, allowing behavior, process, and context to emerge naturally.',
        'narrative_operations': [
            'Show rather than tell',
            'Provide experiential evidence',
            'Reveal behavior',
            'Establish context',
            'Create immediacy',
        ],
    },
    {
        'key': 'Follow shot',
        'label': 'Follow shot',
        'description': 'The camera moves with a subject through an environment, emphasizing movement, routine, or progression through space.',
        'narrative_operations': [
            'Accompany a subject',
            'Trace a process',
            'Reveal environment',
            'Establish spatial progression',
            'Create experiential proximity',
        ],
    },
    {
        'key': 'Point-of-view shot',
        'label': 'Point-of-view shot',
        'description': 'The camera adopts a subject’s visual perspective, showing approximately what they see and creating experiential proximity.',
        'narrative_operations': [
            'Adopt perspective',
            'Simulate experience',
            'Direct attention',
            'Build empathy',
            'Reveal situated knowledge',
        ],
    },
    {
        'key': 'Reveal',
        'label': 'Reveal',
        'description': 'A camera movement or edit gradually exposes previously hidden information, changing how the viewer understands the scene.',
        'narrative_operations': [
            'Reveal information',
            'Recontextualize',
            'Create discovery',
            'Change interpretation',
            'Build anticipation',
        ],
    },
    {
        'key': 'Wide-to-detail sequence',
        'label': 'Wide-to-detail sequence',
        'description': 'Moves from an establishing view of a setting to progressively tighter shots of people, objects, or actions within it.',
        'narrative_operations': [
            'Move from context to evidence',
            'Orient the viewer',
            'Direct attention',
            'Inspect detail',
            'Identify what matters',
        ],
    },
    {
        'key': 'Detail-to-context reveal',
        'label': 'Detail-to-context reveal',
        'description': 'Begins with a close detail and then widens or cuts outward to reveal the larger system, setting, or situation it belongs to.',
        'narrative_operations': [
            'Move from evidence to context',
            'Reveal scale',
            'Reveal system',
            'Recontextualize',
            'Connect part to whole',
        ],
    },
    {
        'key': 'Process sequence',
        'label': 'Process sequence',
        'description': 'A series of shots showing successive stages of an activity, experiment, construction, or transformation.',
        'narrative_operations': [
            'Explain process',
            'Establish sequence',
            'Show transformation',
            'Make methodology visible',
            'Establish causality',
        ],
    },
    {
        'key': 'Before-and-after comparison',
        'label': 'Before-and-after comparison',
        'description': 'Contrasts the same subject, place, or phenomenon at two points in time to make change visible.',
        'narrative_operations': [
            'Show change',
            'Compare states',
            'Demonstrate effect',
            'Establish consequence',
            'Make difference visible',
        ],
    },
    {
        'key': 'Parallel editing',
        'label': 'Parallel editing',
        'description': 'Alternates between two activities, people, or locations to suggest simultaneity, comparison, or an emerging relationship.',
        'narrative_operations': [
            'Compare',
            'Show simultaneity',
            'Establish relationship',
            'Suggest causality',
            'Build convergence',
        ],
    },
    {
        'key': 'Match cut',
        'label': 'Match cut',
        'description': 'Cuts between visually or conceptually similar images, creating a connection between otherwise separate subjects or contexts.',
        'narrative_operations': [
            'Create analogy',
            'Connect concepts',
            'Bridge contexts',
            'Suggest continuity',
            'Reframe similarity',
        ],
    },
    {
        'key': 'Graphic match',
        'label': 'Graphic match',
        'description': 'Transitions between shots that share a similar shape, composition, movement, or visual structure.',
        'narrative_operations': [
            'Create visual analogy',
            'Connect disparate contexts',
            'Smooth transition',
            'Highlight structural similarity',
        ],
    },
    {
        'key': 'Contrast cut',
        'label': 'Contrast cut',
        'description': 'Places sharply different images next to one another to emphasize disagreement, disparity, irony, or change.',
        'narrative_operations': [
            'Contrast',
            'Reveal discrepancy',
            'Challenge expectation',
            'Create irony',
            'Emphasize change',
        ],
    },
    {
        'key': 'Reaction shot',
        'label': 'Reaction shot',
        'description': 'Cuts from an event or statement to someone observing or responding to it, foregrounding interpretation or emotional consequence.',
        'narrative_operations': [
            'Show consequence',
            'Reveal interpretation',
            'Humanize an event',
            'Show emotional response',
            'Establish significance',
        ],
    },
    {
        'key': 'B-roll illustration',
        'label': 'B-roll illustration',
        'description': 'Supporting footage plays over narration or interview audio to visually illustrate what is being discussed.',
        'narrative_operations': [
            'Illustrate explanation',
            'Ground abstraction',
            'Provide context',
            'Provide visual evidence',
            'Maintain continuity',
        ],
    },
    {
        'key': 'Archival footage',
        'label': 'Archival footage',
        'description': 'Existing historical video or film is introduced as evidence, context, memory, or comparison with the present.',
        'narrative_operations': [
            'Provide historical evidence',
            'Establish context',
            'Compare past and present',
            'Support a claim',
            'Establish provenance',
        ],
    },
    {
        'key': 'Archival document',
        'label': 'Archival document',
        'description': 'Documents, photographs, notebooks, correspondence, news clippings, or other records are shown as historical or evidentiary material.',
        'narrative_operations': [
            'Provide evidence',
            'Establish provenance',
            'Document history',
            'Support credibility',
            'Ground a claim',
        ],
    },
    {
        'key': 'Data visualization',
        'label': 'Data visualization',
        'description': 'Charts, maps, diagrams, or animated data representations make patterns, comparisons, quantities, or relationships visible.',
        'narrative_operations': [
            'Make evidence visible',
            'Compare quantities',
            'Reveal pattern',
            'Show relationship',
            'Support a claim',
        ],
    },
    {
        'key': 'Animated diagram',
        'label': 'Animated diagram',
        'description': 'A simplified graphic representation dynamically shows a mechanism, relationship, sequence, or abstract concept.',
        'narrative_operations': [
            'Explain mechanism',
            'Explain abstract concept',
            'Show relationship',
            'Show causality',
            'Simplify complexity',
        ],
    },
    {
        'key': 'Map progression',
        'label': 'Map progression',
        'description': 'A map is animated or edited over time to show movement, geographic relationships, spread, or changes across locations.',
        'narrative_operations': [
            'Establish geography',
            'Trace movement',
            'Show spread',
            'Compare locations',
            'Reveal spatial pattern',
        ],
    },
    {
        'key': 'Reenactment',
        'label': 'Reenactment',
        'description': 'An event that was not filmed is recreated through staged action to illustrate testimony, history, or an otherwise inaccessible moment.',
        'narrative_operations': [
            'Reconstruct an event',
            'Visualize testimony',
            'Make inaccessible events visible',
            'Create experiential understanding',
        ],
    },
    {
        'key': 'Demonstration',
        'label': 'Demonstration',
        'description': 'A subject performs an action or shows how something works on camera, turning explanation into visible evidence.',
        'narrative_operations': [
            'Explain mechanism',
            'Provide direct evidence',
            'Show process',
            'Validate a claim',
            'Make abstract explanation concrete',
        ],
    },
    {
        'key': 'Screen recording',
        'label': 'Screen recording',
        'description': 'Records interaction with software, websites, digital tools, or interfaces to directly show a digital process or artifact.',
        'narrative_operations': [
            'Demonstrate interaction',
            'Show process',
            'Provide artifact evidence',
            'Explain functionality',
            'Make methodology visible',
        ],
    },
    {
        'key': 'Object close-up',
        'label': 'Object close-up',
        'description': 'Isolates an important object, material, instrument, or detail so the viewer can inspect evidence that might otherwise be overlooked.',
        'narrative_operations': [
            'Inspect evidence',
            'Direct attention',
            'Emphasize significance',
            'Reveal detail',
            'Make material evidence visible',
        ],
    },
    {
        'key': 'Slow motion',
        'label': 'Slow motion',
        'description': 'Extends a brief action in time so viewers can inspect movement, detail, causality, or an emotionally significant moment.',
        'narrative_operations': [
            'Inspect action',
            'Reveal mechanism',
            'Emphasize a moment',
            'Clarify causality',
            'Create emotional emphasis',
        ],
    },
    {
        'key': 'Long take',
        'label': 'Long take',
        'description': 'Allows an action or environment to unfold without cutting, preserving duration, spatial continuity, or a sense of observation.',
        'narrative_operations': [
            'Preserve duration',
            'Observe process',
            'Establish authenticity',
            'Create immersion',
            'Reveal complexity over time',
        ],
    },
    {
        'key': 'Static tableau',
        'label': 'Static tableau',
        'description': 'Holds a fixed composition for an extended moment, allowing viewers to inspect relationships among people, objects, and environment.',
        'narrative_operations': [
            'Establish context',
            'Invite inspection',
            'Show relationships',
            'Create reflection',
            'Emphasize composition',
        ],
    },
    {
        'key': 'Rack focus',
        'label': 'Rack focus',
        'description': 'Shifts focus between foreground and background subjects to redirect attention or reveal a relationship within the same shot.',
        'narrative_operations': [
            'Redirect attention',
            'Reveal relationship',
            'Shift narrative importance',
            'Connect foreground and background',
        ],
    },
    {
        'key': 'Pan',
        'label': 'Pan',
        'description': 'Rotates the camera horizontally across a scene to reveal context, connect subjects, or guide attention from one entity to another.',
        'narrative_operations': [
            'Reveal adjacent information',
            'Connect entities',
            'Survey an environment',
            'Redirect attention',
            'Establish spatial relationship',
        ],
    },
    {
        'key': 'Tilt',
        'label': 'Tilt',
        'description': 'Rotates the camera vertically to reveal scale, connect vertically separated elements, or guide attention through a scene.',
        'narrative_operations': [
            'Reveal scale',
            'Connect spatially separated elements',
            'Redirect attention',
            'Reveal information',
        ],
    },
    {
        'key': 'Push-in',
        'label': 'Push-in',
        'description': 'Moves the camera closer to a subject to increase emphasis, intimacy, scrutiny, or narrative importance.',
        'narrative_operations': [
            'Emphasize',
            'Inspect',
            'Increase intimacy',
            'Signal importance',
            'Narrow attention',
        ],
    },
    {
        'key': 'Pull-back',
        'label': 'Pull-back',
        'description': 'Moves away from a subject to reveal surrounding context, relationships, scale, or previously unseen information.',
        'narrative_operations': [
            'Reveal context',
            'Reveal scale',
            'Connect part to whole',
            'Recontextualize',
            'Reveal relationship',
        ],
    },
    {
        'key': 'Whip pan',
        'label': 'Whip pan',
        'description': 'A very fast pan connects two subjects or moments with energetic motion, often implying immediacy or a rapid shift in attention.',
        'narrative_operations': [
            'Rapidly redirect attention',
            'Connect events',
            'Create urgency',
            'Create energetic transition',
        ],
    },
    {
        'key': 'Visual motif',
        'label': 'Visual motif',
        'description': 'A recurring image, object, composition, or action appears throughout the documentary to reinforce a concept or thematic connection.',
        'narrative_operations': [
            'Reinforce theme',
            'Create continuity',
            'Recall earlier ideas',
            'Build association',
            'Unify the narrative',
        ],
    },
    {
        'key': 'Visual metaphor',
        'label': 'Visual metaphor',
        'description': 'An image is used to represent an abstract concept indirectly, creating a conceptual rather than literal correspondence.',
        'narrative_operations': [
            'Explain abstraction',
            'Create analogy',
            'Suggest interpretation',
            'Make concept memorable',
            'Evoke meaning',
        ],
    },
    {
        'key': 'Juxtaposition',
        'label': 'Juxtaposition',
        'description': 'Places shots or scenes next to one another so their relationship produces a comparison, contrast, analogy, or new interpretation.',
        'narrative_operations': [
            'Compare',
            'Contrast',
            'Create analogy',
            'Generate interpretation',
            'Reveal contradiction',
        ],
    },
    {
        'key': 'On-screen text',
        'label': 'On-screen text',
        'description': 'Words shown on screen - titles, labels, quotes, or statistics - convey information directly to the viewer.',
        'narrative_operations': [
            'Label',
            'Convey data',
            'Provide context',
            'Emphasize a point',
            'Attribute a source',
        ],
    },
    {
        'key': 'Three-point lighting',
        'label': 'Three-point lighting',
        'description': 'The classic controlled setup - a key light, a softer fill, and a back light - for a polished, evenly modeled subject (the standard interview look).',
        'narrative_operations': [
            'Establish authority',
            'Shape the subject',
            'Create depth',
            'Convey polish',
            'Direct attention',
        ],
    },
    {
        'key': 'High-key lighting',
        'label': 'High-key lighting',
        'description': 'Bright, even, low-contrast illumination with few shadows - a clean, clinical, optimistic look.',
        'narrative_operations': [
            'Convey clarity',
            'Set an upbeat tone',
            'Feel clinical or neutral',
            'Reduce drama',
            'Aid explanation',
        ],
    },
    {
        'key': 'Low-key lighting',
        'label': 'Low-key lighting',
        'description': 'Deep shadows and high contrast (chiaroscuro), with light carving the subject out of darkness - dramatic and serious.',
        'narrative_operations': [
            'Establish mood',
            'Build tension',
            'Convey gravity',
            'Create mystery',
            'Direct attention',
        ],
    },
    {
        'key': 'Natural light',
        'label': 'Natural light',
        'description': 'Available/ambient light used as-is, without added fixtures - an unstaged, observational authenticity.',
        'narrative_operations': [
            'Create authenticity',
            'Ground in reality',
            'Feel unstaged',
            'Convey atmosphere',
            'Establish place',
        ],
    },
    {
        'key': 'Silhouette / backlight',
        'label': 'Silhouette / backlight',
        'description': 'The subject is rendered dark against a bright background, reduced to an outline - for anonymity, mystery, or a graphic reveal.',
        'narrative_operations': [
            'Protect anonymity',
            'Create mystery',
            'Emphasize shape',
            'Convey drama',
            'Abstract the subject',
        ],
    },
    {
        'key': 'Practical lighting',
        'label': 'Practical lighting',
        'description': 'The scene is lit by visible in-frame sources - lamps, monitors, windows - for grounded, lived-in realism.',
        'narrative_operations': [
            'Ground in reality',
            'Establish place',
            'Create immersion',
            'Motivate the light',
            'Convey atmosphere',
        ],
    },
]

DOCUMENTARY_TECHNIQUE_KEYS = tuple(t['key'] for t in DOCUMENTARY_TECHNIQUES)
