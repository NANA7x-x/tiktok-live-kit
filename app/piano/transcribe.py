# ピアノの録音（wav）から、弾いた音（いつ・どの音・どのくらいの強さ）とペダルを書き出す
# 使い方: python transcribe.py 入力.wav 出力.json
# AI: ByteDance「High-resolution Piano Transcription with Pedals」(piano_transcription_inference)
import json
import sys


def main():
    if len(sys.argv) < 3:
        print("使い方: python transcribe.py 入力.wav 出力.json")
        sys.exit(2)
    src, dst = sys.argv[1], sys.argv[2]
    try:
        from piano_transcription_inference import PianoTranscription, sample_rate, load_audio
    except ImportError:
        print("NEED_SETUP: 採譜のAIが入っていません。ツール/ピアノ動画の準備.bat を先に実行してください。")
        sys.exit(3)
    try:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        device = "cpu"
    print(f"録音を読みこみ中…（{device}）", flush=True)
    audio, _ = load_audio(src, sr=sample_rate, mono=True)
    print("採譜中…（曲の長さと同じくらいかかることがあります）", flush=True)
    tr = PianoTranscription(device=device, checkpoint_path=None)
    out = tr.transcribe(audio, dst[:-5] + ".mid")  # MIDI も一緒にできる（DAW などでも使える）
    notes = [
        {"p": int(n["midi_note"]), "on": round(float(n["onset_time"]), 4), "off": round(float(n["offset_time"]), 4), "v": int(n["velocity"])}
        for n in out.get("est_note_events", [])
    ]
    pedals = [
        {"on": round(float(e["onset_time"]), 4), "off": round(float(e["offset_time"]), 4)}
        for e in out.get("est_pedal_events", [])
    ]
    notes.sort(key=lambda n: n["on"])
    dur = len(audio) / sample_rate
    with open(dst, "w", encoding="utf-8") as f:
        json.dump({"duration": round(dur, 3), "notes": notes, "pedals": pedals}, f, ensure_ascii=False)
    print(f"OK: {len(notes)} 音、ペダル {len(pedals)} 回", flush=True)


if __name__ == "__main__":
    main()
