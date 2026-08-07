"""Shared catalog of documentary modes (the classic Bill Nichols taxonomy,
curated to the 4 most applicable to a research-paper documentary) - a
stylistic axis independent of narrative arc *structure*
(narrative_arc_llm.py's ARC_TEMPLATES) and of documentary_goal (free-text
content/focus). See storyboard_llm.py/edit_plan_llm.py for how each mode's
own per-call guidance shapes narration/visual and pacing/transition choices
respectively - this module only holds the structural/display data.

Kept in sync by convention with js/paper-extract.js's DOCUMENTARY_MODES -
same convention as backend/narrative_arc_llm.py's ARC_TEMPLATES.
"""

DOCUMENTARY_MODES = [
    {
        'key': 'expository',
        'label': 'Expository',
        'description': 'A confident narrator explains directly to the audience - clear, didactic, fact-forward.',
    },
    {
        'key': 'observational',
        'label': 'Observational',
        'description': 'Fly-on-the-wall - minimal narration, let the research and researchers speak for themselves.',
    },
    {
        'key': 'participatory',
        'label': 'Participatory',
        'description': 'The filmmaker/researcher is visibly part of the story - interview-style, first-person.',
    },
    {
        'key': 'poetic',
        'label': 'Poetic',
        'description': 'Mood and imagery over exposition - evocative, associative, unhurried.',
    },
]

DOCUMENTARY_MODE_KEYS = tuple(m['key'] for m in DOCUMENTARY_MODES)
