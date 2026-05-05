"""Gradio web UI for the humanize pipeline.

  - Drop one image  -> Before/After comparison + single download
  - Drop many       -> Gallery + auto-saved to ~/Downloads/Humanize/<ts>/
                       (click 'Open Finder' to grab them, no ZIP)

Run:
    python app.py

Opens at http://127.0.0.1:7860 by default.
"""
import io
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path

import gradio as gr
from PIL import Image

from humanize import process_image_bytes
from iphone_camouflage import random_dcim_name


SAVE_ROOT = Path.home() / "Downloads" / "Humanize"


def _output_name(stem: str, preset: str, used_dcim: set[str]) -> str:
    if preset == "iphone":
        for _ in range(100):
            candidate = random_dcim_name()
            if candidate not in used_dcim:
                used_dcim.add(candidate)
                return f"{candidate}.JPG"
        return f"IMG_{abs(hash(stem)) % 10000:04d}.JPG"
    return f"{stem}_humanized.jpg"


def _human_kb(n: int) -> str:
    if n < 1024 * 1024:
        return f"{n / 1024:.0f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def run(files, preset):
    empty = (
        gr.update(value=[]),         # gallery
        gr.update(value=None),       # before
        gr.update(value=None),       # after
        gr.update(value=None),       # single_download
        gr.update(value=None),       # batch_individual
        gr.update(value=""),         # status
        gr.update(visible=False),    # single_block
        gr.update(visible=False),    # batch_block
        "",                          # save_dir_state
        gr.update(visible=False),    # open_btn
    )
    if not files:
        return empty

    used_dcim: set[str] = set()
    items = []
    work_dir = Path(tempfile.mkdtemp(prefix="humanize_run_"))
    for f in files:
        src_path = Path(f.name if hasattr(f, "name") else f)
        src_bytes = src_path.read_bytes()
        out_bytes = process_image_bytes(src_bytes, preset)
        original = Image.open(io.BytesIO(src_bytes)).convert("RGB")
        processed = Image.open(io.BytesIO(out_bytes)).convert("RGB")
        out_name = _output_name(src_path.stem, preset, used_dcim)
        out_path = work_dir / out_name
        out_path.write_bytes(out_bytes)
        items.append({
            "stem": src_path.stem,
            "out_name": out_name,
            "out_path": str(out_path),
            "out_bytes": out_bytes,
            "original": original,
            "processed": processed,
            "in_size": len(src_bytes),
            "out_size": len(out_bytes),
        })

    total_in = sum(it["in_size"] for it in items)
    total_out = sum(it["out_size"] for it in items)
    delta_pct = (total_out - total_in) * 100 / max(1, total_in)
    sign = "+" if delta_pct >= 0 else ""

    if len(items) == 1:
        it = items[0]
        status_md = (
            f"**1 image** · preset `{preset}` · "
            f"{_human_kb(it['in_size'])} → {_human_kb(it['out_size'])} "
            f"({sign}{delta_pct:.0f}%) · saved as `{it['out_name']}`"
        )
        return (
            gr.update(value=[]),
            gr.update(value=it["original"]),
            gr.update(value=it["processed"]),
            gr.update(value=it["out_path"]),
            gr.update(value=None),
            gr.update(value=status_md),
            gr.update(visible=True),
            gr.update(visible=False),
            "",
            gr.update(visible=False),
        )

    save_dir = SAVE_ROOT / datetime.now().strftime("%Y-%m-%d_%H%M%S")
    save_dir.mkdir(parents=True, exist_ok=True)
    for it in items:
        (save_dir / it["out_name"]).write_bytes(it["out_bytes"])

    gallery = [(it["processed"], it["out_name"]) for it in items]
    individual_paths = [it["out_path"] for it in items]
    pretty_path = str(save_dir).replace(str(Path.home()), "~")

    status_md = (
        f"**{len(items)} images** · preset `{preset}` · "
        f"{_human_kb(total_in)} → {_human_kb(total_out)} "
        f"({sign}{delta_pct:.0f}%) · saved to `{pretty_path}`"
    )

    return (
        gr.update(value=gallery),
        gr.update(value=None),
        gr.update(value=None),
        gr.update(value=None),
        gr.update(value=individual_paths),
        gr.update(value=status_md),
        gr.update(visible=False),
        gr.update(visible=True),
        str(save_dir),
        gr.update(visible=True),
    )


def open_in_finder(folder_path: str):
    if folder_path and Path(folder_path).exists():
        subprocess.Popen(["open", folder_path])
    return gr.update()


CSS = """
.gradio-container { max-width: 1180px !important; }
#hero { padding: 8px 0 4px; }
#status-bar {
  margin: 6px 0 12px;
  padding: 10px 14px;
  border-radius: 10px;
  background: #f3f4f6;
  font-size: 13px;
  min-height: 22px;
}
#status-bar:empty { display: none; }
#dropzone .wrap { min-height: 220px; }
.preset-radio label span { font-weight: 500; }
"""


with gr.Blocks(title="Humanize") as demo:
    save_dir_state = gr.State("")

    with gr.Column(elem_id="hero"):
        gr.Markdown(
            "# Humanize\n"
            "Strip AI-detection fingerprints. Drop **one** for a before/after, "
            "or drop **many** to auto-save to `~/Downloads/Humanize/`."
        )

    files = gr.File(
        label="Drop image(s) here",
        file_count="multiple",
        file_types=["image"],
        elem_id="dropzone",
        height=220,
    )

    with gr.Row():
        with gr.Column(scale=3):
            preset = gr.Radio(
                choices=["iphone", "strong", "light"],
                value="iphone",
                label="Preset",
                info=(
                    "iphone = strong + vignette + Display P3 + iPhone EXIF + IMG_XXXX.JPG. "
                    "strong = full pipeline. light = metadata strip + JPEG only."
                ),
                elem_classes=["preset-radio"],
            )
        with gr.Column(scale=1, min_width=160):
            btn = gr.Button("Process", variant="primary", size="lg")

    status = gr.Markdown("", elem_id="status-bar")

    with gr.Group(visible=False) as single_block:
        with gr.Row():
            before = gr.Image(label="Before", type="pil", interactive=False, height=420)
            after = gr.Image(label="After", type="pil", interactive=False, height=420)
        single_download = gr.File(label="Download", interactive=False)

    with gr.Group(visible=False) as batch_block:
        gallery = gr.Gallery(
            label="Processed",
            columns=4,
            height=440,
            object_fit="contain",
            show_label=True,
        )
        with gr.Row():
            open_btn = gr.Button(
                "📂 Open in Finder",
                variant="primary",
                size="lg",
                visible=False,
            )
        batch_individual = gr.File(
            label="Or download files individually (browser)",
            file_count="multiple",
            interactive=False,
        )

    btn.click(
        run,
        inputs=[files, preset],
        outputs=[
            gallery, before, after,
            single_download, batch_individual,
            status, single_block, batch_block,
            save_dir_state, open_btn,
        ],
    )
    open_btn.click(open_in_finder, inputs=[save_dir_state], outputs=[])


if __name__ == "__main__":
    demo.launch(theme=gr.themes.Soft(), css=CSS)
