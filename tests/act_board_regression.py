#!/usr/bin/env python3
"""Browser-level Act Board regression simulations.

The runner uses the real storyboard.html/JavaScript and a deterministic
fixture, while mocking the backend routes. This makes it useful on a laptop
without API keys, media-provider access, or a running Flask server.

Usage:
    python3 tests/act_board_regression.py
    python3 tests/act_board_regression.py --headed
    python3 tests/act_board_regression.py --url http://localhost:5500/html/storyboard.html

The default run starts serve.py on a free local port and tears it down when
finished. Pass --url to use an already-running frontend server instead.
"""

from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import urlparse


try:
    from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
    from playwright.sync_api import sync_playwright
except ImportError as exc:  # pragma: no cover - exercised by the CLI user
    raise SystemExit(
        "Playwright is required. Install it with `python3 -m pip install playwright` "
        "and `python3 -m playwright install chromium`."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
SESSION_KEY = "paperExtractDebugSession"
IMAGE_URL = "/assets/footage.svg"
VIDEO_URL = "/assets/IMG_2387.mp4"


class RegressionFailure(AssertionError):
    """A readable failure from one simulation."""


def check(condition: bool, message: str) -> None:
    if not condition:
        raise RegressionFailure(message)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def footage_node(node_id: str, scene_id: str, fragment: str, selected: bool = True) -> dict[str, Any]:
    result = {
        "id": f"result-{node_id}",
        "video_url": VIDEO_URL,
        "localPreviewUrl": VIDEO_URL,
        "thumbnail_url": IMAGE_URL,
        "duration_seconds": 8,
        "source": "Pexels",
    }
    return {
        "id": node_id,
        "type": "footage",
        "actKey": "Act 1",
        "sceneId": scene_id,
        "narrationNodeId": "n1",
        "fragment": fragment,
        "filmabilityQuery": fragment,
        "query": fragment,
        "results": [result],
        "generatedOptions": [],
        "selectedVisualKey": "result-0" if selected else None,
        "selectedResultIndex": 0 if selected else None,
        "mediaUrl": VIDEO_URL if selected else "",
        "mediaThumbnailUrl": IMAGE_URL if selected else "",
        "mediaKind": "video" if selected else "",
        "mediaOrigin": "suggested" if selected else "",
        "status": "ready",
        "durationSeconds": 4,
        "trimStartSeconds": 0,
        "sourceDurationSeconds": 8,
        "startSeconds": 0,
        "previousFootageNodeId": None,
        "nextFootageNodeId": None,
        "sequenceIndex": 0,
        "boardX": 100,
        "boardY": 300,
        "boardPositionMode": "manual",
    }


def narration_node(scene_id: str, with_footage: bool = True) -> dict[str, Any]:
    text = "Researchers measured coastal change across three seasons."
    start = text.index("coastal change")
    return {
        "id": "n1",
        "type": "narration",
        "actKey": "Act 1",
        "sceneId": scene_id,
        "status": "ready",
        "text": text,
        "transcript": "",
        "sceneNotes": "Original editable source material.",
        "narrationSpans": [{
            "text": "coastal change",
            "start": start,
            "end": start + len("coastal change"),
            "bucket": "depictable",
            "query": "coastal change shoreline",
        }],
        "narrationSpanStatus": "ready",
        "footageFragments": ["coastal change"] if with_footage else [],
        "footageNodeIds": ["f1"] if with_footage else [],
        "footageSuggestedPhrases": [],
        "selectedFootagePhrases": [],
        "userFilmablePhrases": [],
        "narrationSpanExclusions": [],
        "footageStatus": "",
        "includeNarration": True,
        "audioPreviewUrl": VIDEO_URL,
        "audioDurationSeconds": 4,
        "sourceDurationSeconds": 4,
        "narrationSegmentDurationSeconds": 4,
        "durationSeconds": 4,
        "startSeconds": 0,
        "trimStartSeconds": 0,
        "previousNarrationNodeId": None,
        "nextNarrationNodeId": None,
        "boardX": 80,
        "boardY": 70,
        "boardPositionMode": "manual",
    }


def audio_node(scene_id: str) -> dict[str, Any]:
    return {
        "id": "a1",
        "type": "audio",
        "actKey": "Act 1",
        "sceneId": scene_id,
        "audioKind": "sound-effects",
        "status": "ready",
        "query": "",
        "results": [],
        "selectedAudio": {
            "name": "Fixture sound",
            "preview_url": VIDEO_URL,
            "localPreviewUrl": VIDEO_URL,
            "sourceDurationSeconds": 4,
            "durationSeconds": 2,
            "duration": 4,
            "trimStartSeconds": 0,
        },
        "audioName": "Fixture sound",
        "audioPreviewUrl": VIDEO_URL,
        "sourceDurationSeconds": 4,
        "startSeconds": 0,
        "durationSeconds": 2,
        "trimStartSeconds": 0,
        "volume": 0.8,
        "linkedToNodeId": None,
        "linkedToType": None,
        "previousAudioNodeId": None,
        "nextAudioNodeId": None,
        "boardX": 360,
        "boardY": 70,
        "boardPositionMode": "manual",
    }


def scene(scene_id: str, title: str, node_ids: list[str], x: int = 0, y: int = 0) -> dict[str, Any]:
    return {
        "id": scene_id,
        "actKey": "Act 1",
        "title": title,
        "nodeIds": node_ids,
        "nodeSnapshots": [],
        "nodeLinks": [],
        "documentaryMode": "expository",
        "documentaryModeSource": "moodboard",
        "includeNarration": True,
        "sequenceStartNodeId": "f1" if "f1" in node_ids else None,
        "boardX": x,
        "boardY": y,
        "boardWidth": 1000,
        "boardHeight": 600,
        "boardPositionMode": "manual",
        "timelineDurationSeconds": 8,
        "committedToStack": True,
    }


def fixture_session(with_footage: bool = True, second_scene: bool = True) -> dict[str, Any]:
    first_scene_id = "scene-1"
    n1 = narration_node(first_scene_id, with_footage)
    nodes: list[dict[str, Any]] = [n1]
    first_ids = ["n1"]
    if with_footage:
        f1 = footage_node("f1", first_scene_id, "coastal change")
        n1["footageNodeIds"] = ["f1"]
        nodes.append(f1)
        first_ids.append("f1")
    nodes.append(audio_node(first_scene_id))
    first_ids.append("a1")

    scenes = [scene(first_scene_id, "Scene 1", first_ids)]
    if second_scene:
        second_scene_id = "scene-2"
        n2 = {
            **narration_node(second_scene_id, False),
            "id": "n2",
            "text": "The coastline changed as the tide returned.",
            "boardX": 80,
            "boardY": 70,
        }
        f2 = {
            **footage_node("f2", second_scene_id, "returning tide"),
            "id": "f2",
            "narrationNodeId": "n2",
            "actKey": "Act 1",
            "boardX": 100,
            "boardY": 300,
        }
        n2["footageNodeIds"] = ["f2"]
        nodes.extend([n2, f2])
        scenes.append(scene(second_scene_id, "Scene 2", ["n2", "f2"], 0, 700))

    all_ids = [node["id"] for node in nodes]
    return {
        "currentLabel": "Act Board regression fixture",
        "currentSections": [
            {"index": 1, "title": "Scene 1", "text": "Original paper text for scene one.", "image": IMAGE_URL},
            {"index": 2, "title": "Scene 2", "text": "Original paper text for scene two.", "image": IMAGE_URL},
        ],
        "currentAssignments": {"1": "Act 1", "2": "Act 1"},
        "currentArcSections": [{
            "key": "Act 1",
            "label": "Act 1",
            "description": "The fixture act description.",
        }],
        "actBoardNodes": {"Act 1": nodes},
        "actBoardScenes": {"Act 1": scenes},
        "actBoardOpenSceneByAct": {"Act 1": first_scene_id},
        "actBoardInitialScenesInitialized": True,
        "actBoardInitialSceneActKeys": ["Act 1"],
        "actBoardFirstArcAutoPopulationDone": True,
        "selectedNarrationArc": {
            "arc_name": "Fixture arc",
            "sections": [{"name": "Act 1", "suggested_narration": "Fixture narration."}],
        },
        "lastDistillResult": None,
        "recordedTranscript": "",
        "moodboardReferences": [],
        "selectedFocusStatements": [],
        "selectedTechniques": [],
        "actBoardSetupMode": "expository",
        "recordedNarrationDurationSeconds": None,
        "recordedNarrationExtension": "webm",
        "persistedNarrationPreviewUrl": None,
        "premiereProjectId": None,
        "premiereTimelineCollapsed": False,
        "sidebarModuleCollapsed": {},
        "sidebarPanelsCollapsed": True,
        "paperSnapshotId": "act-board-regression",
        "_fixtureNodeIds": all_ids,
    }


def stress_fixture_session() -> dict[str, Any]:
    """Fixture with several filmable beats in one narration segment."""
    session = fixture_session(False, False)
    narration = session["actBoardNodes"]["Act 1"][0]
    phrases = [
        "coastal change", "tidal wetlands", "research vessels",
        "storm barriers", "returning tide",
    ]
    narration["text"] = (
        "Researchers measured coastal change across tidal wetlands while "
        "research vessels mapped storm barriers and the returning tide."
    )
    narration["transcript"] = narration["text"]
    narration["narrationSpans"] = []
    for phrase in phrases:
        start = narration["text"].find(phrase)
        narration["narrationSpans"].append({
            "text": phrase,
            "start": start,
            "end": start + len(phrase),
            "bucket": "depictable",
            "query": f"documentary footage of {phrase}",
        })
    narration["narrationSpanStatus"] = "ready"
    narration["footageFragments"] = phrases[:]
    narration["selectedFootagePhrases"] = [
        {"text": phrase, "start": narration["text"].find(phrase),
         "end": narration["text"].find(phrase) + len(phrase)}
        for phrase in phrases
    ]
    return session


def visualize_placement_fixture_session() -> dict[str, Any]:
    session = fixture_session(True, False)
    narration = next(node for node in session["actBoardNodes"]["Act 1"] if node["id"] == "n1")
    # Visualize is intentionally available for the placement regression only
    # when the scene has a current narration transcript. The base fixture is
    # used by track-only tests and leaves transcript empty, which disables the
    # control even when selected phrases are seeded below.
    narration["transcript"] = narration["text"]
    phrase = "three seasons"
    start = narration["text"].index(phrase)
    narration["selectedFootagePhrases"] = [{
        "text": phrase,
        "query": "three seasons coastal study",
        "start": start,
        "end": start + len(phrase),
    }]
    return session


def visualize_after_rerecord_fixture_session() -> dict[str, Any]:
    """Existing footage must not suppress highlights from a new transcript."""
    session = fixture_session(True, False)
    narration = next(node for node in session["actBoardNodes"]["Act 1"] if node["id"] == "n1")
    narration["text"] = "Researchers tracked river flooding across the valley."
    narration["transcript"] = narration["text"]
    start = narration["text"].index("river flooding")
    narration["narrationSpans"] = [{
        "text": "river flooding", "start": start,
        "end": start + len("river flooding"), "bucket": "depictable",
        "query": "river flooding documentary",
    }]
    narration["narrationSpanStatus"] = "ready"
    narration["narrationSpanHash"] = ""
    narration["selectedFootagePhrases"] = []
    narration["userFilmablePhrases"] = []
    narration["footageSuggestedPhrases"] = []
    return session


def manual_highlight_fixture_session() -> dict[str, Any]:
    """A transcript with no classifier span for an arbitrary selection."""
    session = fixture_session(False, False)
    narration = next(node for node in session["actBoardNodes"]["Act 1"] if node["id"] == "n1")
    narration["text"] = "Election night coverage showed a city watching together."
    narration["transcript"] = narration["text"]
    narration["narrationSpans"] = []
    narration["narrationCandidateSpans"] = []
    narration["narrationSpanStatus"] = "ready"
    narration["narrationSpanHash"] = ""
    narration["selectedFootagePhrases"] = []
    narration["userFilmablePhrases"] = []
    narration["footageSuggestedPhrases"] = []
    return session


def footage_composition_fixture_session() -> dict[str, Any]:
    """Two independent footage cards in one scene for split/merge drops."""
    session = fixture_session(True, False)
    nodes = session["actBoardNodes"]["Act 1"]
    scene_data = session["actBoardScenes"]["Act 1"][0]
    # Keep the original f1 attached to the narration umbrella. The second
    # card is deliberately free-standing so the drop menu exercises the same
    # path presenters use when composing two independent ideas.
    f2 = footage_node("f2", "scene-1", "tidal wetlands")
    f2["narrationNodeId"] = None
    f2["sequenceIndex"] = 1
    f2["startSeconds"] = 4
    f2["boardX"] = 340
    f2["boardY"] = 300
    nodes.append(f2)
    scene_data["nodeIds"].append("f2")
    scene_data["timelineDurationSeconds"] = 12
    session["_fixtureNodeIds"] = [node["id"] for node in nodes]
    return session


def run_visualize_after_rerecord(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    button = page.locator(".storyboard-act-board-scene-visualize-highlights-btn")
    check(button.count() > 0, "No scene Visualize highlights button was rendered.")
    button.click()
    page.wait_for_function(
        "() => Array.from(document.querySelectorAll('.storyboard-act-board-node-footage'))"
        ".some(node => node.textContent.toLowerCase().includes('river flooding'))",
        timeout=12_000,
    )
    page.wait_for_timeout(900)
    state = state_from_page(page)
    span_calls = [item for item in calls if item["path"].endswith("/narration/spans")]
    check(any("river flooding" in str(item.get("body", {}).get("text", "")) for item in span_calls),
          "Visualize did not analyze the current rerecorded transcript.")
    nodes = [node for node in state["actBoardNodes"]["Act 1"] if node["type"] == "footage"]
    check(any(node.get("fragment") == "river flooding" for node in nodes),
          f"Visualize did not create footage for the newly recorded transcript highlight: {[node.get('fragment') for node in nodes]}")
    old = next(node for node in nodes if node["id"] == "f1")
    check(old.get("selectedVisualKey") == "result-0" and old.get("boardX") == 100,
          "Visualize changed existing selected footage while processing a new transcript.")
    check(page.locator(".storyboard-act-board-scene-loading:visible").count() == 0,
          "Scene loading veil remained after rerecorded visualization completed.")


def run_manual_highlight_classification(page, calls: list[dict[str, Any]]) -> None:
    """Arbitrary presenter highlights use the phrase-level filmability LLM."""
    wait_for_board(page)
    page.evaluate("""() => {
      const node = actBoardNodesForAct('Act 1').find(item => item.id === 'n1');
      const text = node.transcript;
      const phrase = 'Election night';
      const start = text.indexOf(phrase);
      handleActBoardNarrationSpanSelect(node, {
        text: phrase, start, end: start + phrase.length,
        kind: 'user_selection', origin: 'manual', bucket: 'pending', query: ''
      }, phrase, true);
    }""")
    page.wait_for_timeout(500)
    manual_calls = [item for item in calls
                    if item["path"].endswith("/narration/classify")
                    and any(span.get("kind") == "user_selection"
                            for span in item.get("body", {}).get("spans", []))]
    check(manual_calls, "Manual highlight did not reach the filmability classifier.")
    candidate = manual_calls[-1]["body"]["spans"][0]
    check(candidate.get("text") == "Election night",
          "Manual classifier candidate did not preserve the highlighted phrase.")
    check(candidate.get("start") == 0 and candidate.get("end") == len("Election night"),
          "Manual classifier candidate did not preserve character offsets.")
    # Invoke the same high-level action used by the Visualize Highlights
    # control. The scene control itself is covered by the existing visualize
    # regressions; this case focuses on the phrase-classifier handoff.
    page.evaluate("async()=>{const n=actBoardNodesForAct('Act 1').find(x=>x.id==='n1'); await suggestActBoardFootage('Act 1', currentArcSections[0], n, n.transcript)}")
    page.wait_for_function(
        "() => { try { const session = JSON.parse(localStorage.getItem('paperExtractDebugSession') || '{}');"
        " return (session.actBoardNodes?.['Act 1'] || []).some(node =>"
        " node.type === 'footage' && node.fragment === 'Election night'); } catch (_) { return false; } }",
        timeout=12_000,
    )
    state = state_from_page(page)
    footage = [node for node in state["actBoardNodes"]["Act 1"]
               if node["type"] == "footage" and node.get("fragment") == "Election night"]
    check(footage, "Visualize did not create footage for the arbitrary highlight.")
    check(footage[0].get("filmabilityQuery") == "people watching election night coverage",
          "Footage did not use the classified query for the arbitrary highlight.")
    check(not any(item["path"].endswith("/paper/media_queries") for item in calls),
          "A successful phrase classification incorrectly fell back to scene media queries.")


def run_new_narration_autosuggest(page, calls: list[dict[str, Any]]) -> None:
    """Canvas-created narration segments receive a draft without footage."""
    wait_for_board(page)
    coords = page.evaluate("""() => {
      const stack = document.querySelector('.storyboard-act-board-node-stack');
      const scene = stack?.querySelector('.storyboard-act-board-board-scene');
      if (!stack || !scene) return null;
      const rect = scene.getBoundingClientRect();
      const x = Math.min(rect.right - 24, Math.max(rect.left + 24,
        Math.min(rect.left + 450, window.innerWidth - 460)));
      const y = Math.min(rect.bottom - 24, Math.max(rect.top + 140, window.innerHeight - 48));
      stack.dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, view: window, clientX: x, clientY: y,
      }));
      return {x, y};
    }""")
    check(coords is not None, "Could not locate the open Act Board scene.")
    page.get_by_role("button", name="Narration", exact=True).click(force=True)
    page.wait_for_function(
        "() => document.querySelectorAll('.storyboard-act-board-scene-narration-slide').length >= 2",
        timeout=8_000,
    )
    page.wait_for_function(
        "() => Array.from(document.querySelectorAll('.storyboard-act-board-scene-suggested-narration'))"
        ".some(node => node.textContent.includes('Updated narration from edited scene notes.'))",
        timeout=12_000,
    )
    narration_calls = [item for item in calls if item["path"].endswith("/paper/suggest_narration")]
    check(narration_calls, "A new narration segment did not request suggested narration.")
    body = narration_calls[-1]["body"]
    check("fixture act description" in str(body.get("act_description", "")).lower(),
          "Initial narration suggestion omitted the act description.")
    check("Original paper text" in str(body.get("section_text", "")),
          "Initial narration suggestion omitted source material.")
    state = state_from_page(page)
    persisted_footage = [node for node in state["actBoardNodes"]["Act 1"]
                         if node["type"] == "footage"]
    check([node["id"] for node in persisted_footage] == ["f1"],
          "Initial narration suggestion spawned footage automatically.")


def run_narration_recording_lifecycle(page, calls: list[dict[str, Any]]) -> None:
    """Exercise record/stop, rerecord, and explicit new-segment controls."""
    wait_for_board(page)
    initial_slides = page.locator(".storyboard-act-board-scene-narration-slide").count()
    record = page.locator(".storyboard-act-board-scene-record-narration-btn").first

    # Seed the runtime recorder registry with a deterministic fake. This tests
    # the production scene-rail proxy's start/stop routing without requiring a
    # real microphone or a browser AudioContext in CI.
    page.evaluate("""() => {
      const node = actBoardNodesForAct('Act 1').find(item => item.id === 'n1');
      window.__fixtureRecorderStops = 0;
      const recorder = {
        state: 'recording',
        stop() { window.__fixtureRecorderStops += 1; this.state = 'inactive'; },
      };
      actBoardNarrationRecorderStates.set('n1', {
        recorder, starting: false,
        button: document.querySelector('.storyboard-act-board-record-narration-btn'),
      });
      node.recordingStatus = 'recording';
      rerenderActBoard();
    }""")
    check(record.get_attribute("aria-pressed") == "true",
          "The narration record control did not expose its active recording state.")
    record.dispatch_event("click")
    state = state_from_page(page)
    check(page.evaluate("window.__fixtureRecorderStops") == 1,
          "The second press did not stop the active narration recorder.")
    check(page.locator(".storyboard-act-board-scene-narration-slide").count() == initial_slides,
          "Stopping a recording unexpectedly created a second narration segment.")

    # A rerecord uses the same segment identity and the same stop path.
    page.evaluate("""() => {
      const node = actBoardNodesForAct('Act 1').find(item => item.id === 'n1');
      const recorder = {
        state: 'recording',
        stop() { window.__fixtureRecorderStops += 1; this.state = 'inactive'; },
      };
      actBoardNarrationRecorderStates.set('n1', { recorder, starting: false,
        button: document.querySelector('.storyboard-act-board-record-narration-btn') });
      node.recordingStatus = 'recording';
      rerenderActBoard();
    }""")
    check(record.get_attribute("aria-pressed") == "true",
          "The rerecord control did not expose its active recording state.")
    record.dispatch_event("click")
    state = state_from_page(page)
    narration_nodes = [node for node in state["actBoardNodes"]["Act 1"]
                       if node["type"] == "narration"]
    check(page.evaluate("window.__fixtureRecorderStops") == 2,
          "Rerecording did not stop the existing narration recorder.")
    check(len(narration_nodes) == 1 and narration_nodes[0]["id"] == "n1",
          "Rerecording created or removed a narration segment.")
    page.evaluate("""() => {
      const node = actBoardNodesForAct('Act 1').find(item => item.id === 'n1');
      node.recordingStatus = 'ready';
      actBoardNarrationRecorderStates.delete('n1');
      rerenderActBoard();
    }""")
    page.wait_for_timeout(250)

    # Additional segments remain an explicit canvas action; recording itself
    # never creates one as a side effect of stopping.
    page.evaluate("""() => {
      const scene = actBoardScenesForAct('Act 1')[0];
      createActBoardNarrationSegmentNode('Act 1', scene);
      saveDebugSession();
      rerenderActBoard();
    }""")
    page.wait_for_function(
        "count => document.querySelectorAll('.storyboard-act-board-scene-narration-slide').length > count",
        arg=initial_slides,
        timeout=8_000,
    )
    page.wait_for_timeout(400)
    state = state_from_page(page)
    narration_count = len([node for node in state["actBoardNodes"]["Act 1"]
                           if node["type"] == "narration"])
    check(narration_count == 2,
          f"Explicitly adding a narration segment did not add exactly one segment (count={narration_count}).")


def footage_drop(page, source_id: str, target_id: str) -> None:
    """Drag a footage card over another long enough to open its drop menu."""
    # Scene footage layers can sit below the initial viewport. Scroll the
    # destination into view first; the source and target in this fixture are
    # adjacent, so both remain visible for the synthetic pointer sequence.
    page.locator(
        f'.storyboard-act-board-node-footage[data-node-id="{target_id}"]'
    ).scroll_into_view_if_needed()
    page.wait_for_timeout(100)
    # Native video children can swallow synthetic pointer capture in headless
    # browsers. Call the production hover controller with the same target
    # coordinates the drag handler uses, then open the menu as pointerup does
    # after the hold threshold.
    page.evaluate("""({sourceId, targetId}) => {
      const source = actBoardNodesForAct('Act 1').find(node => node.id === sourceId);
      const target = document.querySelector(`.storyboard-act-board-node-footage[data-node-id="${targetId}"]`);
      const boardLayer = target?.closest('.storyboard-act-board-node-stack');
      if (!boardLayer || !source || !target || typeof updateActBoardFootageDropHover !== 'function') {
        throw new Error('Missing footage cards or drop-hover controller.');
      }
      const rect = target.getBoundingClientRect();
      updateActBoardFootageDropHover(boardLayer, source,
        rect.left + rect.width / 2, rect.top + rect.height / 2);
    }""", {"sourceId": source_id, "targetId": target_id})
    page.wait_for_timeout(850)
    shaking = page.locator(".storyboard-act-board-node-footage.footage-drop-shaking").count()
    hover_debug = page.evaluate("""() => {
      const hover = document.querySelector('.storyboard-act-board-node-stack')?._actBoardFootageDropHover;
      return hover ? {source: hover.source?.id, target: hover.target?.id, ready: hover.ready} : null;
    }""")
    card_classes = page.evaluate("""() => Array.from(document.querySelectorAll('.storyboard-act-board-node-footage'))
      .map(card => ({id: card.dataset.nodeId, className: card.className}))""")
    check(shaking >= 1 and hover_debug and hover_debug.get("ready"),
          f"Holding a footage card over another did not show the drop affordance (shaking={shaking}, hover={hover_debug}, cards={card_classes}).")
    page.evaluate("""({sourceId, targetId}) => {
      const source = actBoardNodesForAct('Act 1').find(node => node.id === sourceId);
      const target = actBoardNodesForAct('Act 1').find(node => node.id === targetId);
      const targetCard = document.querySelector(`.storyboard-act-board-node-footage[data-node-id="${targetId}"]`);
      const boardLayer = targetCard?.closest('.storyboard-act-board-node-stack');
      if (!boardLayer || !source || !target || !targetCard) return;
      const rect = targetCard.getBoundingClientRect();
      openActBoardFootageDropMenu('Act 1', source, target, boardLayer,
        rect.left + rect.width / 2, rect.top + rect.height / 2);
    }""", {"sourceId": source_id, "targetId": target_id})
    page.wait_for_timeout(200)
    check(page.locator(".storyboard-act-board-footage-drop-menu").count() == 1,
          "Footage drop did not open the merge/split menu.")


def run_footage_composition(page, calls: list[dict[str, Any]], choice: str) -> None:
    wait_for_board(page)
    footage_drop(page, "f2", "f1")
    label = "Create split screen" if choice == "split-screen" else "Merge with generative media"
    page.locator(".storyboard-act-board-footage-drop-choice").filter(
        has_text=label,
    ).click(force=True)
    page.wait_for_function(
        "mode => { try { const state = JSON.parse(localStorage.getItem(%r) || '{}');"
        " return (state.actBoardNodes?.['Act 1'] || []).some(node =>"
        " node.type === 'footage' && node.compositionMode === mode);"
        " } catch (_) { return false; } }" % SESSION_KEY,
        arg=choice,
        timeout=5_000,
    )
    state = state_from_page(page)
    composites = [node for node in state["actBoardNodes"]["Act 1"]
                  if node["type"] == "footage" and node.get("compositionMode") == choice]
    check(len(composites) == 1, f"{choice} did not create exactly one third footage node.")
    composite = composites[0]
    scene_data = state["actBoardScenes"]["Act 1"][0]
    check(composite["id"] in scene_data.get("nodeIds", []),
          f"{choice} node was not attached to the scene.")
    check(page.locator(
        f'.storyboard-act-board-selected-scene-playback-panel [data-footage-node-id="{composite["id"]}"]'
    ).count() == 1, f"{choice} node is missing from scene playback.")

    # Full playback and combined export must serialize the composition too.
    # Build the exact production plan and send the same render request without
    # starting the UI's polling timer; the ordinary playback-button regression
    # separately covers the panel interaction and status polling.
    render_plan = page.evaluate("() => buildActBoardRenderPlan()")
    check(composite["id"] in json.dumps(render_plan, sort_keys=True),
          f"{choice} node is missing from the full playback plan.")
    page.evaluate("""async () => {
      const plan = buildActBoardRenderPlan();
      await fetchRenderStart([], '', plan.soundEffects, plan.narrations, plan.sequences);
    }""")
    full_calls = [item for item in calls if item["path"].endswith("/render/start")]
    check(full_calls, f"{choice} full playback did not call the render endpoint.")
    sequence_json = json.dumps(full_calls[-1]["body"], sort_keys=True)
    check(composite["id"] in sequence_json,
          f"{choice} node is missing from the full playback render plan.")
    page.evaluate("async () => { await runExportForPremiere(); }")
    premiere_calls = [item for item in calls if item["path"].endswith("/premiere/export")]
    check(premiere_calls, f"{choice} Premiere export was not requested.")
    check(composite["id"] in json.dumps(premiere_calls[-1]["body"], sort_keys=True),
          f"{choice} node is missing from the Premiere export plan.")


def reorder_fixture_session() -> dict[str, Any]:
    """Three-segment fixture used to exercise lifted insertion reordering."""
    session = fixture_session(True, False)
    nodes = session["actBoardNodes"]["Act 1"]
    scene_data = session["actBoardScenes"]["Act 1"][0]
    n1 = next(node for node in nodes if node["id"] == "n1")
    f1 = next(node for node in nodes if node["id"] == "f1")
    a1 = next(node for node in nodes if node["id"] == "a1")
    for index, (node_type, prefix, template, fragment) in enumerate([
        ("narration", "n", n1, "second narration segment"),
        ("narration", "n", n1, "third narration segment"),
        ("footage", "f", f1, "second footage segment"),
        ("footage", "f", f1, "third footage segment"),
        ("audio", "a", a1, "second sound segment"),
        ("audio", "a", a1, "third sound segment"),
    ]):
        clone = copy.deepcopy(template)
        clone["id"] = f"{prefix}{index + 2}"
        clone["type"] = node_type
        clone["fragment"] = fragment
        clone["sceneId"] = "scene-1"
        clone["narrationNodeId"] = None if node_type != "footage" else "n1"
        clone["sequenceIndex"] = index + 1
        clone["startSeconds"] = (index + 1) * 4
        clone["durationSeconds"] = 4 if node_type != "audio" else 2
        clone["trimStartSeconds"] = .5
        if node_type == "audio":
            clone["audioName"] = fragment
            clone["selectedAudio"]["name"] = fragment
            clone["selectedAudio"]["trimStartSeconds"] = .5
        nodes.append(clone)
    narration_nodes = [node for node in nodes if node["type"] == "narration"]
    footage_nodes = [node for node in nodes if node["type"] == "footage"]
    audio_nodes = [node for node in nodes if node["type"] == "audio"]
    for group, previous_key, next_key in [
        (narration_nodes, "previousNarrationNodeId", "nextNarrationNodeId"),
        (footage_nodes, "previousFootageNodeId", "nextFootageNodeId"),
        (audio_nodes, "previousAudioNodeId", "nextAudioNodeId"),
    ]:
        for index, node in enumerate(group):
            node[previous_key] = group[index - 1]["id"] if index else None
            node[next_key] = group[index + 1]["id"] if index + 1 < len(group) else None
    scene_data["nodeIds"] = [node["id"] for node in nodes]
    scene_data["timelineDurationSeconds"] = 14
    return session


def json_body(route) -> dict[str, Any]:
    try:
        value = route.request.post_data_json
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def install_backend_mocks(context, calls: list[dict[str, Any]]) -> None:
    def handle(route) -> None:
        request = route.request
        parsed = urlparse(request.url)
        path = parsed.path
        body = json_body(route)
        calls.append({"path": path, "method": request.method, "body": body})

        response: dict[str, Any] = {}
        if path.endswith("/paper/suggest_narration"):
            response = {"narration": "Updated narration from edited scene notes."}
        elif path.endswith("/transcribe"):
            # The recording lifecycle test supplies a fake MediaRecorder blob;
            # return a deterministic transcript with word timestamps so the
            # browser exercises the same post-recording alignment path as a
            # real Whisper response.
            response = {
                "text": "Recorded segment words here.",
                "words": [
                    {"word": "Recorded", "start": 0.0, "end": 0.45},
                    {"word": "segment", "start": 0.45, "end": 0.9},
                    {"word": "words", "start": 0.9, "end": 1.25},
                    {"word": "here.", "start": 1.25, "end": 1.6},
                ],
            }
        elif path.endswith("/narration/spans"):
            text = str(body.get("text") or "")
            stress_phrases = [
                "coastal change", "tidal wetlands", "research vessels",
                "storm barriers", "returning tide",
            ]
            if all(phrase in text for phrase in stress_phrases):
                response = {"spans": [
                    {"text": phrase, "start": text.find(phrase),
                     "end": text.find(phrase) + len(phrase)}
                    for phrase in stress_phrases
                ]}
            else:
                phrase = ("river flooding" if "river flooding" in text
                          else ("coastal change" if "coastal change" in text
                                else (text.split(" ")[0] if text else "coast")))
                start = text.find(phrase)
                response = {"spans": [{"text": phrase, "start": max(0, start), "end": max(0, start) + len(phrase)}]}
        elif path.endswith("/narration/classify"):
            spans = body.get("spans") if isinstance(body.get("spans"), list) else []
            response = {"spans": [
                {**span, "bucket": "depictable",
                 "query": (f"people watching {span.get('text', '').lower()} coverage"
                           if span.get("kind") == "user_selection"
                           else span.get("text", ""))}
                for span in spans if isinstance(span, dict) and span.get("text")
            ] or [{"text": "coastal change", "bucket": "depictable", "query": "coastal change shoreline"}]}
        elif path.endswith("/paper/media_queries"):
            response = {"video_query": "coastal change shoreline", "audio_query": "coastal change"}
        elif path.endswith("/media/search_video"):
            response = {"videos": [
                {"id": f"video-{index}", "video_url": VIDEO_URL, "thumbnail_url": IMAGE_URL,
                 "source_url": "https://example.test/video", "source": "Pexels", "duration_seconds": 8}
                for index in range(10)
            ]}
        elif path.endswith("/paper/generate_shot_examples"):
            count = max(1, int(body.get("count") or 1))
            response = {"project_id": "fixture-project", "shot_plan": {"shot_size": "wide", "movement": "static"}, "examples": [
                {"preview_url": IMAGE_URL, "thumbnail_url": IMAGE_URL, "kind": "image", "label": f"Generated {index + 1}",
                 "shot_size": "wide", "movement": "static", "techniques": ["Wide shot"]}
                for index in range(count)
            ]}
        elif path.endswith("/paper/generate_shot_plan"):
            response = {"project_id": "fixture-project", "shot_plan": {
                "shot_size": "medium", "movement": "push_in", "narrative_operation": "reveal",
                "visual_description": body.get("visual_description") or "A visible shoreline.",
            }}
        elif path.endswith("/paper/generate_shot_video"):
            response = {"project_id": "fixture-project", "preview_url": VIDEO_URL,
                        "thumbnail_url": IMAGE_URL, "shot_plan": {"movement": "push_in"}}
        elif path.endswith("/premiere/download_stock_media"):
            response = {"project_id": "fixture-project", "preview_url": VIDEO_URL,
                        "thumbnail_url": IMAGE_URL, "duration_seconds": 8}
        elif path.endswith("/premiere/upload_media_bank_item"):
            response = {"project_id": "fixture-project", "preview_url": VIDEO_URL,
                        "file_path": "fixture-recording.wav", "duration_seconds": 1.6}
        elif path.endswith("/premiere/export"):
            response = {"ok": True, "project_id": "fixture-project", "folder_path": "fixture-export"}
        elif path.endswith("/render/start"):
            response = {"project_id": "fixture-render", "preview_url": VIDEO_URL}
        elif path.endswith("/render/status"):
            response = {"state": "done", "message": "Fixture render complete."}
        elif path.endswith("/paper/snapshots/save"):
            response = {"ok": True}
        else:
            response = {"ok": True}
        route.fulfill(status=200, content_type="application/json", body=json.dumps(response))

    context.route("http://127.0.0.1:8000/**", handle)


def seed_session(context, session: dict[str, Any]) -> None:
    serialized = json.dumps({key: value for key, value in session.items() if not key.startswith("_")})
    context.add_init_script(
        "window.localStorage.setItem(%s, %s);"
        % (json.dumps(SESSION_KEY), json.dumps(serialized))
    )


def wait_for_board(page) -> None:
    page.locator(".storyboard-act-board-view").wait_for(state="visible", timeout=12_000)
    page.wait_for_timeout(250)


def state_from_page(page) -> dict[str, Any]:
    raw = page.evaluate("key => window.localStorage.getItem(key)", SESSION_KEY)
    check(raw, "The app did not persist a debug session.")
    return json.loads(raw)


def click_node(page, node_id: str) -> None:
    locator = page.locator(f'.storyboard-act-board-node[data-node-id="{node_id}"]')
    locator.wait_for(state="visible", timeout=8_000)
    locator.click(position={"x": 12, "y": 12})
    page.wait_for_timeout(150)


def open_story_outline(page) -> None:
    """Open the outline view and wait out any node-analysis rerender."""
    page.wait_for_timeout(750)
    for _ in range(3):
        page.get_by_role("button", name="Story outline").click(force=True)
        try:
            page.wait_for_function(
                """() => {
                    const panel = document.querySelector('.storyboard-act-board-full-playback-view-overview');
                    return panel && !panel.hidden && getComputedStyle(panel).display !== 'none';
                }""",
                timeout=2_000,
            )
            return
        except PlaywrightTimeoutError:
            page.wait_for_timeout(250)
    raise RegressionFailure("Could not open the Story outline view.")


def run_tracks_and_scene_reload(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    canvas_ids = set(filter(None, page.locator(
        ".storyboard-act-board-canvas-playback-tracks .storyboard-act-board-footage-track-segment"
    ).evaluate_all("items => items.map(item => item.dataset.footageNodeId)")))
    panel_ids = set(filter(None, page.locator(
        ".storyboard-act-board-selected-scene-playback-panel .storyboard-act-board-footage-track-segment"
    ).evaluate_all("items => items.map(item => item.dataset.footageNodeId)")))
    check(canvas_ids == {"f1"}, f"Canvas footage track mismatch: {canvas_ids}")
    check(panel_ids == {"f1"}, f"Playback-panel footage track mismatch: {panel_ids}")
    canvas_audio_ids = set(filter(None, page.locator(
        ".storyboard-act-board-canvas-playback-tracks [data-audio-node-id]"
    ).evaluate_all("items => items.map(item => item.dataset.audioNodeId)")))
    panel_audio_ids = set(filter(None, page.locator(
        ".storyboard-act-board-selected-scene-playback-panel [data-audio-node-id]"
    ).evaluate_all("items => items.map(item => item.dataset.audioNodeId)")))
    check(canvas_audio_ids == {"n1", "a1"}, f"Canvas audio tracks mismatch: {canvas_audio_ids}")
    check(panel_audio_ids == {"n1", "a1"}, f"Playback-panel audio tracks mismatch: {panel_audio_ids}")
    check(page.locator('.storyboard-act-board-canvas-playback-tracks [data-audio-node-id="a1"]').count() == 1,
          "Canvas audio track is missing.")
    check(page.locator('.storyboard-act-board-selected-scene-playback-panel [data-audio-node-id="a1"]').count() == 1,
          "Playback-panel audio track is missing.")
    check(page.locator(".storyboard-act-board-narration-source-editor").count() >= 1,
          "Narration source editor is missing from the selected-node content.")
    click_node(page, "f1")
    check(page.locator('.storyboard-act-board-footage-source-editor[data-footage-node-id="f1"]').count() >= 1,
          "Footage source editor is missing from the selected-node content.")
    click_node(page, "a1")
    check(page.locator('.storyboard-act-board-audio-source-editor').count() >= 1,
          "Audio source editor is missing from the selected-node content.")

    # Selecting a node opens the panel's node-content view. Switch back to the
    # outline before exercising scene restore behavior.
    open_story_outline(page)
    scene_two = page.locator(".storyboard-act-board-full-playback-scene").filter(has_text="Scene 2")
    scene_two.click()
    page.wait_for_timeout(450)
    state = state_from_page(page)
    scenes = state["actBoardScenes"]["Act 1"]
    check(any(item["id"] == "scene-1" and item["nodeIds"] for item in scenes),
          "Loading Scene 2 erased Scene 1's saved nodes.")
    check(any(item["id"] == "scene-2" for item in scenes), "Scene 2 disappeared after loading it.")
    open_story_outline(page)
    scene_one = page.locator(".storyboard-act-board-full-playback-scene").filter(has_text="Scene 1")
    scene_one.click()
    page.wait_for_timeout(450)
    check(page.locator('.storyboard-act-board-node[data-node-id="n1"]').count() == 1,
          "Reloading Scene 1 did not restore its nodes.")


def run_visualize(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    page.get_by_role("button", name="Visualize highlights").click()
    page.wait_for_function(
        """() => document.querySelectorAll('.storyboard-act-board-node-footage').length >= 1""",
        timeout=12_000,
    )
    page.wait_for_timeout(250)
    check(page.locator(".storyboard-act-board-narration-phrase-has-footage, .storyboard-act-board-narration-span-depictable").count() >= 1,
          "Visualize highlights did not apply the footage highlight styling.")
    check(any(item["path"].endswith("/media/search_video") for item in calls),
          "Visualize highlights never requested stock footage.")
    check(any(item["path"].endswith("/paper/generate_shot_examples") for item in calls),
          "Visualize highlights never requested AI image examples.")


def run_visualize_preserves_placement(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    before = page.evaluate("""() => {
      const card = document.querySelector('.storyboard-act-board-node-stack [data-node-id="f1"]');
      return {x: card?.style.left || '', y: card?.style.top || '',
        width: card?.offsetWidth || 0, height: card?.offsetHeight || 0};
    }""")
    page.get_by_role("button", name="Visualize highlights").click()
    page.wait_for_function(
        "() => document.querySelectorAll('.storyboard-act-board-node-stack "
        ".storyboard-act-board-node-footage[data-node-id]').length >= 2",
        timeout=12_000,
    )
    page.wait_for_timeout(500)
    result = page.evaluate("""() => {
      const section = document.querySelector('.storyboard-act-board-scene-section-footage')
        ?.getBoundingClientRect();
      const cards = Array.from(document.querySelectorAll(
        '.storyboard-act-board-node-stack .storyboard-act-board-node-footage[data-node-id]'))
        .map(card => {
          const rect = card.getBoundingClientRect();
          return {id: card.dataset.nodeId, left: rect.left, top: rect.top,
            right: rect.right, bottom: rect.bottom};
        });
      const existing = document.querySelector('.storyboard-act-board-node-stack [data-node-id="f1"]');
      return {
        section: section ? {left: section.left, top: section.top,
          right: section.right, bottom: section.bottom} : null,
        cards,
        existing: existing ? {x: existing.style.left, y: existing.style.top,
          width: existing.offsetWidth, height: existing.offsetHeight} : null,
      };
    }""")
    check(result["existing"] == before,
          "Visualize highlights moved or resized an existing footage card.")
    check(result["section"] is not None, "The scene Footage section is missing.")
    new_cards = [card for card in result["cards"] if card["id"] != "f1"]
    check(new_cards, "Visualize highlights did not create a new footage card.")
    section = result["section"]
    check(all(card["left"] >= section["left"]
              and card["right"] <= section["right"]
              and card["top"] >= section["top"]
              and card["bottom"] <= section["bottom"] for card in new_cards),
          "A newly visualized footage card landed outside the Footage section.")
    for index, first in enumerate(result["cards"]):
        for second in result["cards"][index + 1:]:
            overlaps = (first["left"] < second["right"]
                        and first["right"] > second["left"]
                        and first["top"] < second["bottom"]
                        and first["bottom"] > second["top"])
            check(not overlaps,
                  f"Footage cards overlap after placement: {first['id']} and {second['id']}")


def run_free_footage_movement(page, calls: list[dict[str, Any]]) -> None:
    """A footage card can move anywhere in its lane without row snapping."""
    wait_for_board(page)
    card = page.locator('.storyboard-act-board-node-footage[data-node-id="f1"]')
    card.wait_for(state="visible", timeout=8_000)
    card.scroll_into_view_if_needed()
    page.wait_for_timeout(100)
    box = card.bounding_box()
    check(box is not None, "Could not measure the footage card for movement.")
    before = page.evaluate("""() => {
      const card = document.querySelector('.storyboard-act-board-node-footage[data-node-id="f1"]');
      const layer = card?.closest('.storyboard-act-board-scene-footage-node-layer');
      return {left: card?.style.left || '', top: card?.style.top || '',
        x: card?.getBoundingClientRect().x || 0, y: card?.getBoundingClientRect().y || 0,
        layer: layer ? (() => { const r = layer.getBoundingClientRect();
          return {x: r.x, y: r.y, right: r.right, bottom: r.bottom}; })() : null};
    }""")
    # Start on the card's blank preview area. The production drag handler uses
    # pointer events and absolute layer-local coordinates, so this exercises
    # the same path as a presenter dragging the card by hand.
    start_x = box["x"] + box["width"] * 0.45
    start_y = box["y"] + box["height"] * 0.45
    page.mouse.move(start_x, start_y)
    page.mouse.down()
    # Move both horizontally and into an earlier row; the fixture card starts
    # near the lane's lower edge, so a downward move would correctly clamp.
    page.mouse.move(start_x + 280, start_y - 140, steps=8)
    page.mouse.up()
    page.wait_for_timeout(250)
    result = page.evaluate("""() => {
      const card = document.querySelector('.storyboard-act-board-node-footage[data-node-id="f1"]');
      const layer = card?.closest('.storyboard-act-board-scene-footage-node-layer');
      const r = card?.getBoundingClientRect();
      const lr = layer?.getBoundingClientRect();
      return {left: card?.style.left || '', top: card?.style.top || '',
        x: r?.x || 0, y: r?.y || 0,
        inside: Boolean(r && lr && r.left >= lr.left - 1 && r.right <= lr.right + 1
          && r.top >= lr.top - 1 && r.bottom <= lr.bottom + 1)};
    }""")
    check(result["left"] != before["left"] or result["top"] != before["top"],
          f"Dragging a footage card did not change its position: before={before}, after={result}")
    check(result["x"] > before["x"] + 40 and result["y"] < before["y"] - 40,
          f"Footage card movement was unexpectedly snapped or constrained to its row: before={before}, after={result}")
    check(result["inside"], "Dragged footage card left its Footage layer bounds.")


def run_highlight_stress(page, calls: list[dict[str, Any]]) -> None:
    """Rapidly exercise phrase visualization while measuring main-thread health.

    This is intentionally a browser-level stress check rather than a timing
    assertion about the mocked APIs: it watches animation-frame latency and
    Long Task entries while the app repeatedly rerenders and spawns footage.
    """
    wait_for_board(page)
    page.evaluate(
        """() => {
          window.__actBoardStress = {longTasks: [], errors: []};
          if (window.PerformanceObserver) {
            try {
              const observer = new PerformanceObserver(list => {
                list.getEntries().forEach(entry =>
                  window.__actBoardStress.longTasks.push(entry.duration));
              });
              observer.observe({type: 'longtask', buffered: true});
            } catch (_) {}
          }
          window.addEventListener('error', event =>
            window.__actBoardStress.errors.push(String(event.message || event.error || 'error')));
        }"""
    )
    visualize_buttons = page.locator("button").filter(has_text="Visualize highlights")
    if visualize_buttons.count() == 0:
        visualize_buttons = page.locator("button").filter(has_text="visualize")
    check(visualize_buttons.count() > 0,
          "Stress test could not find a Visualize highlights control.")

    frame_latencies: list[float] = []
    for _ in range(12):
        # Resolve the current button on every burst because visualization
        # rerenders the scene controls and can replace the element identity.
        page.evaluate(
            """() => Array.from(document.querySelectorAll('button')).filter(button =>
              /visualize highlights/i.test(button.textContent || '')
            ).forEach(button => button.click())"""
        )
        latency = page.evaluate(
            """async () => {
              const start = performance.now();
              await new Promise(resolve => requestAnimationFrame(() =>
                requestAnimationFrame(resolve)));
              return performance.now() - start;
            }"""
        )
        frame_latencies.append(float(latency))
        page.wait_for_timeout(75)

    page.wait_for_timeout(2_000)
    metrics = page.evaluate(
        """() => ({
                  footageNodes: document.querySelectorAll('.storyboard-act-board-node-footage').length,
                  footageNodeIds: Array.from(document.querySelectorAll('.storyboard-act-board-node-footage'))
                    .map(node => node.dataset.nodeId || ''),
                  highlightedSpans: document.querySelectorAll(
            '.storyboard-act-board-narration-phrase-has-footage, .storyboard-act-board-narration-span-depictable').length,
                  persistedFilmablePhrases: (() => {
                    try {
                      const session = JSON.parse(localStorage.getItem('paperExtractDebugSession') || '{}');
                      const nodes = session.actBoardNodes?.['Act 1'] || [];
                      const narration = nodes.find(node => node.type === 'narration') || {};
                      return (narration.footageSuggestedPhrases || []).length
                        + (narration.userFilmablePhrases || []).length
                        + (narration.selectedFootagePhrases || []).length;
                    } catch (_) { return 0; }
                  })(),
                  longTasks: window.__actBoardStress?.longTasks || [],
          errors: window.__actBoardStress?.errors || [],
        })"""
    )
    max_frame = max(frame_latencies)
    max_long_task = max(metrics["longTasks"], default=0)
    print(
        "STRESS  visualize bursts=12 footage_nodes={} highlighted_spans={} "
        "persisted_filmable_phrases={} latency_samples_ms={} max_two_frame_latency_ms={:.1f} max_long_task_ms={:.1f} media_searches={} "
        "image_generations={} browser_errors={}".format(
            metrics["footageNodes"], metrics["highlightedSpans"],
            metrics["persistedFilmablePhrases"], [round(value, 1) for value in frame_latencies],
            max_frame, max_long_task,
            len([item for item in calls if item["path"].endswith("/media/search_video")]),
            len([item for item in calls if item["path"].endswith("/paper/generate_shot_examples")]),
            len(metrics["errors"]),
        )
    )
    if metrics["errors"]:
        print(f"STRESS_ERRORS {metrics['errors']}")
    media_search_count = len([item for item in calls if item["path"].endswith("/media/search_video")])
    image_generation_count = len([item for item in calls if item["path"].endswith("/paper/generate_shot_examples")])
    check(metrics["footageNodes"] == 5,
          f"Visualization created {metrics['footageNodes']} footage nodes instead of five.")
    check(len(set(metrics["footageNodeIds"])) == metrics["footageNodes"],
          "Visualization mounted duplicate footage node cards.")
    check(media_search_count == 5,
          f"Visualization issued {media_search_count} stock searches instead of five.")
    check(image_generation_count == 5,
          f"Visualization issued {image_generation_count} image jobs instead of five.")
    check(metrics["persistedFilmablePhrases"] >= 5,
          "Visualization did not persist all filmable phrases.")
    # Incremental rendering target from the Act Board refactor: updates stay
    # within two animation frames and never monopolize the main thread for a
    # quarter second after initial load.
    check(max_frame < 100,
          f"Main thread became unresponsive during visualization (two-frame latency {max_frame:.1f}ms).")
    check(max_long_task < 200,
          f"Visualization produced a blocking long task ({max_long_task:.1f}ms).")
    check(not metrics["errors"], f"Visualization stress produced browser errors: {metrics['errors']}")


def run_smart_arrange(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    button = page.get_by_role("button", name="Smart arrange")
    check(button.count() == 1, "Smart arrange button is missing from the open scene board.")
    before = state_from_page(page)
    before_f1 = next(node for node in before["actBoardNodes"]["Act 1"] if node["id"] == "f1")
    # The fixed node-content panel can overlap the right side of a wide scene
    # board in the fixture; dispatching the real click event tests the handler
    # without making this simulation depend on the panel's viewport geometry.
    button.dispatch_event("click")
    page.wait_for_timeout(450)
    check(page.locator(".storyboard-act-board-scene-sections > .storyboard-act-board-scene-section").count() == 3,
          "Scene board did not render narration, footage, and sound sections.")
    check(page.locator(".storyboard-act-board-scene-narration-scroll-btn").count() == 2,
          "Scene narration scroll controls are missing.")
    state = state_from_page(page)
    nodes = {node["id"]: node for node in state["actBoardNodes"]["Act 1"]}
    check((nodes["f1"].get("boardX"), nodes["f1"].get("boardY")) !=
          (before_f1.get("boardX"), before_f1.get("boardY")),
          "Smart arrange did not change the scene node layout.")
    track_segments = page.locator(
        ".storyboard-act-board-canvas-playback-tracks "
        ".storyboard-act-board-footage-track-segment"
    ).count()
    check(track_segments >= 3,
          "Smart arrange did not populate the narration, footage, and audio track segments.")
    check(nodes["f1"].get("startSeconds") == 0, "Smart arrange did not anchor the first footage shot at narration start.")
    check(float(nodes["f1"].get("durationSeconds", 0)) >= 0.5,
          "Smart arrange produced an invalid footage duration.")


def run_track_reordering(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)

    def rect(locator):
        """Read a live DOM rect; this is more reliable than Playwright's
        bounding_box when a rail is inside an overflowed scene canvas."""
        value = locator.evaluate("""(element) => {
          const rect = element.getBoundingClientRect();
          return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
        }""")
        return value if value and value["width"] > 0 and value["height"] > 0 else None

    def lift_to_start(track_selector: str, segment_selector: str) -> Optional[str]:
        track = page.locator(track_selector).first
        # Use a middle segment so the pointer starts well inside the painted
        # rail (the trailing gap can overlap the final segment while a scene
        # canvas is being resized).
        segment = track.locator(segment_selector).nth(1)
        segment_rects = []
        for _ in range(12):
            segment_rects = track.locator(segment_selector).evaluate_all("""els => els.map(element => {
              const rect = element.getBoundingClientRect();
              return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
            })""")
            if len(segment_rects) > 1 and segment_rects[1]["width"] > 0:
                break
            page.wait_for_timeout(50)
        box = segment_rects[1] if len(segment_rects) > 1 else (segment_rects[0] if segment_rects else None)
        # Use the live segment extents for the drop rail. The scene canvas can
        # replace its track wrapper during an earlier incremental patch, which
        # can make a previously captured wrapper locator report no box even
        # though its children are painted.
        if segment_rects:
            track_left = min(item["x"] for item in segment_rects)
            track_right = max(item["x"] + item["width"] for item in segment_rects)
            track_box = {"x": track_left, "y": box["y"],
                         "width": max(1, track_right - track_left),
                         "height": box["height"]}
        else:
            track_box = None
        check(box and track_box,
              f"Could not measure track segment {segment_selector}; box={box} track_box={track_box} track_count={track.count()} segment_count={track.locator(segment_selector).count()} track_rect={track.evaluate('(e)=>e.getBoundingClientRect().toJSON()')} rects={track.locator(segment_selector).evaluate_all('(els)=>els.map(e=>({r:e.getBoundingClientRect().toJSON(),display:getComputedStyle(e).display,width:getComputedStyle(e).width,height:getComputedStyle(e).height}))')}")
        origin_x = box["x"] + box["width"] / 2
        # Narration segments contain an overlaid waveform/source scrubber in
        # their center; begin at the segment edge so this simulation exercises
        # the shared segment drag controller rather than source scrubbing.
        origin_y = box["y"] + min(2, box["height"] / 3)
        dragged_id = segment.get_attribute("data-audio-node-id") or segment.get_attribute("data-footage-node-id")
        pointer = {"pointerId": 7, "pointerType": "mouse", "button": 0,
                   "buttons": 1, "clientX": origin_x, "clientY": origin_y}
        segment.dispatch_event("pointerdown", pointer)
        page.wait_for_timeout(800)
        ghost = page.locator(".storyboard-act-board-track-floating-ghost")
        try:
            ghost.wait_for(state="attached", timeout=2_000)
        except PlaywrightTimeoutError:
            check(False, "Lifted segment did not create a floating drag ghost.")
        check(track.locator(".storyboard-act-board-track-reorder-marker").is_visible(),
              "Lifted segment did not show an insertion marker.")
        drop_x = track_box["x"] + 5
        segment.dispatch_event("pointermove", {
            **pointer, "clientX": drop_x, "clientY": origin_y,
        })
        page.wait_for_timeout(100)
        check(track.locator(".storyboard-act-board-track-reorder-marker").is_visible(),
              "Insertion marker disappeared before drop.")
        segment.dispatch_event("pointerup", {
            **pointer, "buttons": 0, "clientX": drop_x, "clientY": origin_y,
        })
        page.wait_for_timeout(1200)
        return dragged_id

    # Lift the last segment of each rail and move it before the first segment.
    narration_dragged = lift_to_start(
        '.storyboard-act-board-canvas-playback-tracks [data-track-kind="narration"]',
        '[data-audio-node-id]',
    )
    footage_dragged = lift_to_start(
        '.storyboard-act-board-canvas-playback-tracks [data-track-kind="footage"]',
        '[data-footage-node-id]',
    )
    audio_dragged = lift_to_start(
        '.storyboard-act-board-canvas-playback-tracks [data-track-kind="audio"]',
        '[data-audio-node-id]',
    )
    state = state_from_page(page)
    nodes = state["actBoardNodes"]["Act 1"]
    for node_type, expected_prefix in [("narration", narration_dragged),
                                       ("footage", footage_dragged),
                                       ("audio", audio_dragged)]:
        group = sorted(
            [node for node in nodes if node["type"] == node_type],
            key=lambda node: int(node.get("sequenceIndex") or 0),
        )
        check(group and group[0]["id"] == expected_prefix,
              f"{node_type} lifted reorder did not move the segment to the beginning: {[node['id'] for node in group]}")
        starts = [round(float(node.get("startSeconds") or 0), 2) for node in group]
        durations = [float(node.get("durationSeconds") or 0) for node in group]
        expected_starts = []
        cursor = 0.0
        for duration in durations:
            expected_starts.append(round(cursor, 2))
            cursor += duration
        check(starts == expected_starts,
              f"{node_type} reorder did not repack segment starts: {starts} vs {expected_starts}")
    f5 = next(node for node in nodes if node["id"] == "f5")
    check(float(f5.get("trimStartSeconds") or 0) == .5,
          "Footage reorder changed the source-in value.")
    check(f5.get("selectedVisualKey") == "result-0",
          "Footage reorder changed the selected media.")
    canvas_ids = page.locator(
        '.storyboard-act-board-canvas-playback-tracks [data-track-kind="footage"] [data-footage-node-id]'
    ).evaluate_all("items => items.map(item => item.dataset.footageNodeId)")
    panel_ids = page.locator(
        '.storyboard-act-board-selected-scene-playback-panel [data-track-kind="footage"] [data-footage-node-id]'
    ).evaluate_all("items => items.map(item => item.dataset.footageNodeId)")
    check(canvas_ids == panel_ids, "Canvas and playback-panel footage track orders diverged.")

    # A short drag remains a timing edit and must not reorder the sequence.
    before = [node["id"] for node in sorted(
        [node for node in state["actBoardNodes"]["Act 1"] if node["type"] == "footage"],
        key=lambda node: int(node.get("sequenceIndex") or 0),
    )]
    segment = page.locator(
        '.storyboard-act-board-canvas-playback-tracks [data-track-kind="footage"] [data-footage-node-id]'
    ).first
    box = rect(segment)
    check(box, "Could not measure footage segment for short drag.")
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + min(2, box["height"] / 3))
    page.mouse.down()
    page.wait_for_timeout(120)
    page.mouse.move(box["x"] + box["width"] / 2 + 12, box["y"] + min(2, box["height"] / 3))
    page.mouse.up()
    page.wait_for_timeout(250)
    after = [node["id"] for node in sorted(
        [node for node in state_from_page(page)["actBoardNodes"]["Act 1"] if node["type"] == "footage"],
        key=lambda node: int(node.get("sequenceIndex") or 0),
    )]
    check(before == after, "Short timing drag unexpectedly changed footage order.")

    # Keyboard equivalent: Alt+Right advances the focused segment by one
    # insertion slot without requiring a pointer gesture.
    segment.focus()
    page.keyboard.press("Alt+ArrowRight")
    page.wait_for_timeout(900)
    keyboard_order = [node["id"] for node in sorted(
        [node for node in state_from_page(page)["actBoardNodes"]["Act 1"] if node["type"] == "footage"],
        key=lambda node: int(node.get("sequenceIndex") or 0),
    )]
    check(len(keyboard_order) >= 2 and keyboard_order[1] == before[0],
          "Alt+Right did not move the focused footage segment one slot.")

    # Escape during lifted mode cancels the reorder and restores the order.
    before_cancel = [node["id"] for node in sorted(
        [node for node in state_from_page(page)["actBoardNodes"]["Act 1"] if node["type"] == "audio"],
        key=lambda node: int(node.get("sequenceIndex") or 0),
    )]
    segment = page.locator(
        '.storyboard-act-board-canvas-playback-tracks [data-track-kind="audio"] [data-audio-node-id]'
    ).first
    box = rect(segment)
    check(box, "Could not measure audio segment for Escape cancellation.")
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + min(2, box["height"] / 3))
    page.mouse.down()
    page.wait_for_timeout(800)
    page.mouse.move(box["x"] + 100, box["y"] + min(2, box["height"] / 3))
    page.keyboard.press("Escape")
    page.mouse.up()
    page.wait_for_timeout(250)
    check(page.locator(".storyboard-act-board-track-floating-ghost").count() == 0,
          "Escape did not remove the lifted segment ghost.")
    after_cancel = [node["id"] for node in sorted(
        [node for node in state_from_page(page)["actBoardNodes"]["Act 1"] if node["type"] == "audio"],
        key=lambda node: int(node.get("sequenceIndex") or 0),
    )]
    check(after_cancel == before_cancel,
          "Escape cancellation changed the audio track order.")


def run_generation_inputs(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    click_node(page, "f1")
    page.locator(".storyboard-act-board-image-generation-inputs summary").first.click()
    phrase = page.locator(".storyboard-act-board-image-generation-input-editable").first
    phrase.fill("edited specific phrase")
    page.get_by_role("button", name="Generate image").click()
    page.wait_for_timeout(500)
    image_calls = [item for item in calls if item["path"].endswith("/paper/generate_shot_examples")]
    check(image_calls, "Generate image did not call the shot-examples endpoint.")
    check(image_calls[-1]["body"].get("specific_phrase") == "edited specific phrase",
          "Generate image did not send the edited specific phrase.")
    check(image_calls[-1]["body"].get("count") == 1,
          f"Generate image requested {image_calls[-1]['body'].get('count')} images instead of one.")

    # A generated still must be explicitly selected before image-to-video is
    # enabled. The mocked response labels generated thumbnails as
    # "Generated N", so select one deterministically rather than relying on
    # whichever visual was selected before the image request.
    generated_thumb = page.locator('.storyboard-act-board-footage-thumb[title^="Generated "]').first
    generated_thumb.wait_for(state="visible", timeout=8_000)
    generated_thumb.click()
    page.wait_for_timeout(250)
    click_node(page, "f1")
    page.locator(".storyboard-act-board-video-generation-inputs summary").first.click()
    visual = page.locator(".storyboard-act-board-shot-plan-visual-editor").first
    visual.fill("The subject visibly moves across the frame.")
    page.get_by_role("button", name="Generate video").click()
    page.wait_for_timeout(700)
    plan_calls = [item for item in calls if item["path"].endswith("/paper/generate_shot_plan")]
    video_calls = [item for item in calls if item["path"].endswith("/paper/generate_shot_video")]
    check(plan_calls, "Generate video did not request a shot plan.")
    check(video_calls, "Generate video did not request video generation.")
    check(video_calls[-1]["body"].get("chosen_image_url"), "Generate video omitted the selected image.")
    check("visibly moves" in video_calls[-1]["body"].get("subject_action", ""),
          "Generate video omitted the edited visual field.")


def run_suggest_narration(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    click_node(page, "n1")
    page.locator(".storyboard-act-board-narration-source-notes summary").first.click()
    notes = page.locator(".storyboard-act-board-narration-source-notes-input").first
    notes.fill("Edited source material that should guide the next narration draft.")
    page.get_by_role("button", name="Suggest narration").click()
    page.wait_for_timeout(650)
    narration_calls = [item for item in calls if item["path"].endswith("/paper/suggest_narration")]
    check(narration_calls, "Suggest narration did not call the narration endpoint.")
    check("Edited source material" in narration_calls[-1]["body"].get("section_text", ""),
          "Suggest narration omitted the edited source material.")


def run_playback_and_export(page, calls: list[dict[str, Any]]) -> None:
    wait_for_board(page)
    click_node(page, "n1")
    page.get_by_role("button", name="Full play").click()
    page.get_by_role("button", name="Build full playback").click()
    page.wait_for_timeout(500)
    full_calls = [item for item in calls if item["path"].endswith("/render/start")]
    check(full_calls, "Full playback did not call the render endpoint.")
    board_sequences = full_calls[-1]["body"].get("board_sequences") or []
    check(len(board_sequences) >= 2, "Full playback did not include all fixture scenes.")
    scene_ids = [sequence.get("scene_id") for sequence in board_sequences]
    check(scene_ids == ["scene-1", "scene-2"], f"Full playback scene order was {scene_ids}.")

    # The combined export remains a separate user action and should write both
    # the Premiere plan and the MP4 render request.
    page.get_by_role("button", name="Export premiere + MP4").click()
    page.wait_for_timeout(500)
    premiere_calls = [item for item in calls if item["path"].endswith("/premiere/export")]
    check(premiere_calls,
          "Premiere export endpoint was not called.")
    check(premiere_calls[-1]["body"].get("sections"),
          "Act Board Premiere export sent an empty sections fallback.")
    check(len([item for item in calls if item["path"].endswith("/render/start")]) >= 2,
          "MP4 render endpoint was not called by combined export.")


def run_one(
    browser,
    base_url: str,
    session: dict[str, Any],
    test: Callable[[Any, list[dict[str, Any]]], None],
) -> None:
    context = browser.new_context(viewport={"width": 1440, "height": 900})
    calls: list[dict[str, Any]] = []
    seed_session(context, session)
    install_backend_mocks(context, calls)
    page = context.new_page()
    try:
        page.goto(base_url, wait_until="domcontentloaded", timeout=15_000)
        test(page, calls)
    finally:
        context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--headed", action="store_true", help="Show the Chromium window while simulations run.")
    parser.add_argument("--url", help="Existing storyboard.html URL; otherwise start serve.py automatically.")
    parser.add_argument("--stress-only", action="store_true", help="Run only the rapid visualization responsiveness simulation.")
    parser.add_argument("--reorder-only", action="store_true", help="Run only the lifted track-segment reorder simulation.")
    parser.add_argument("--placement-only", action="store_true", help="Run only the Visualize Highlights placement simulation.")
    parser.add_argument("--movement-only", action="store_true", help="Run only the free footage-card movement simulation.")
    parser.add_argument("--rerecord-only", action="store_true", help="Run only the post-rerecord visualization simulation.")
    parser.add_argument("--autosuggest-only", action="store_true", help="Run only the new-narration autosuggest simulations.")
    parser.add_argument("--manual-only", action="store_true", help="Run only the arbitrary manual-highlight simulation.")
    parser.add_argument("--recording-only", action="store_true", help="Run only the narration record/stop/rerecord simulation.")
    parser.add_argument("--composition-only", action="store_true", help="Run only the footage merge/split composition simulations.")
    parser.add_argument("--split-only", action="store_true", help="Run only the split-screen composition simulation.")
    parser.add_argument("--merge-only", action="store_true", help="Run only the merged composition simulation.")
    args = parser.parse_args()

    server = None
    if args.url:
        base_url = args.url
    else:
        port = free_port()
        server = subprocess.Popen(
            [sys.executable, str(ROOT / "serve.py"), str(port)],
            cwd=ROOT,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        base_url = f"http://localhost:{port}/html/storyboard.html"
        time.sleep(0.35)

    tests: list[tuple[str, dict[str, Any], Callable[[Any, list[dict[str, Any]]], None]]] = [
        ("visualize highlights remains responsive under rapid repeated use", stress_fixture_session(), run_highlight_stress),
        ("tracks stay synced and scenes reload safely", fixture_session(True, True), run_tracks_and_scene_reload),
        ("visualize highlights finds and generates footage", fixture_session(False, False), run_visualize),
        ("visualize preserves existing footage placement", visualize_placement_fixture_session(), run_visualize_preserves_placement),
        ("footage cards move freely within the Footage lane", fixture_session(True, False), run_free_footage_movement),
        ("visualize processes highlights after a rerecord", visualize_after_rerecord_fixture_session(), run_visualize_after_rerecord),
        ("manual highlights use phrase-level filmability queries", manual_highlight_fixture_session(), run_manual_highlight_classification),
        ("new narration segments receive suggested narration", fixture_session(True, False), run_new_narration_autosuggest),
        ("narration recording supports stop, rerecord, and new segments", fixture_session(True, False), run_narration_recording_lifecycle),
        ("footage drop creates a split-screen composition", footage_composition_fixture_session(),
         lambda page, calls: run_footage_composition(page, calls, "split-screen")),
        ("footage drop creates a merged composition", footage_composition_fixture_session(),
         lambda page, calls: run_footage_composition(page, calls, "merged")),
        ("lifted track segments reorder without rebuilding the board", reorder_fixture_session(), run_track_reordering),
        ("smart arrange aligns scene nodes to narration", fixture_session(True, False), run_smart_arrange),
        ("edited generation inputs reach image/video APIs", fixture_session(True, False), run_generation_inputs),
        ("edited source material reaches suggest narration", fixture_session(True, False), run_suggest_narration),
        ("scene/full playback and combined export include all scenes", fixture_session(True, True), run_playback_and_export),
    ]
    if args.stress_only:
        tests = [next(item for item in tests if item[0].startswith("visualize highlights remains responsive"))]
    elif args.reorder_only:
        tests = [next(item for item in tests if item[0].startswith("lifted track segments reorder"))]
    elif args.placement_only:
        tests = [next(item for item in tests if item[0].startswith("visualize preserves existing footage"))]
    elif args.movement_only:
        tests = [next(item for item in tests if item[0].startswith("footage cards move freely"))]
    elif args.rerecord_only:
        tests = [next(item for item in tests if item[0].startswith("visualize processes highlights after a rerecord"))]
    elif args.autosuggest_only:
        tests = [next(item for item in tests if item[0].startswith("new narration segments receive"))]
    elif args.manual_only:
        tests = [next(item for item in tests if item[0].startswith("manual highlights use phrase-level"))]
    elif args.recording_only:
        tests = [next(item for item in tests if item[0].startswith("narration recording supports"))]
    elif args.composition_only:
        tests = [item for item in tests if item[0].startswith("footage drop creates")]
    elif args.split_only:
        tests = [next(item for item in tests if item[0].startswith("footage drop creates a split"))]
    elif args.merge_only:
        tests = [next(item for item in tests if item[0].startswith("footage drop creates a merged"))]

    passed = 0
    failed: list[tuple[str, str]] = []
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=not args.headed)
            try:
                for name, session, test in tests:
                    try:
                        run_one(browser, base_url, session, test)
                        print(f"PASS  {name}")
                        passed += 1
                    except (RegressionFailure, PlaywrightTimeoutError) as exc:
                        print(f"FAIL  {name}: {exc}")
                        failed.append((name, str(exc)))
            finally:
                browser.close()
    finally:
        if server is not None:
            server.terminate()
            try:
                server.wait(timeout=3)
            except subprocess.TimeoutExpired:
                server.kill()

    print(f"\n{passed}/{len(tests)} simulations passed.")
    if failed:
        print("Failures:")
        for name, message in failed:
            print(f"- {name}: {message}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
