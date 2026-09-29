import json
import sys


def main() -> None:
    from faster_whisper import WhisperModel

    model = WhisperModel("base", device="cpu", compute_type="int8")
    for line in sys.stdin:
        audio_path = line.strip()
        if not audio_path:
            continue
        try:
            segments, _info = model.transcribe(
                audio_path,
                language=None,
                beam_size=1,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 350}
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            sys.stdout.write(json.dumps({"text": text}, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception as error:
            sys.stdout.write(json.dumps({"error": str(error)}, ensure_ascii=False) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        sys.stderr.write(str(error))
        sys.exit(1)
