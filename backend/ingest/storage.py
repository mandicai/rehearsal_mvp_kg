"""On-disk layout for a data-collection project: projects/<project_id>/ holds
the original upload, rendered snapshots, and (once saved) project.json. Kept
separate from the pre-baked root slides.json + snapshots/ fixture used by
index.html/feedback.html/carta.html - this package never touches those."""
import json
import re
from pathlib import Path

PROJECTS_DIR = Path(__file__).resolve().parent.parent.parent / 'projects'

_RUN_ID_RE = re.compile(r'^rehearsal-run-(\d+)$')


def next_rehearsal_run_id():
    """Each recorded rehearsal gets a plain sequential id (rehearsal-run-1,
    rehearsal-run-2, ...) - scans existing projects/ directories rather than
    keeping a counter in a database, since this is a single-user local tool."""
    existing = [
        int(m.group(1))
        for p in (PROJECTS_DIR.iterdir() if PROJECTS_DIR.exists() else [])
        if (m := _RUN_ID_RE.match(p.name))
    ]
    return f'rehearsal-run-{max(existing, default=0) + 1}'


def project_dir(project_id):
    return PROJECTS_DIR / project_id


def snapshots_dir(project_id):
    return project_dir(project_id) / 'snapshots'


def save_project(project_id, data):
    """Write the final project JSON (see server.py's /projects/save) to
    projects/<project_id>/project.json. Returns the written Path."""
    target_dir = project_dir(project_id)
    target_dir.mkdir(parents=True, exist_ok=True)
    path = target_dir / 'project.json'
    path.write_text(json.dumps(data, indent=2))
    return path
