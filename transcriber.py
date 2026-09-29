"""Локальное распознавание речи через faster-whisper.

Протокол общения с Electron (main.js):
  stdin  — одна JSON-строка на запрос: {"id": 1, "path": "C:\\...\\segment.webm"}
           (для совместимости принимается и просто путь к файлу отдельной строкой);
  stdout — одна JSON-строка на ответ:  {"id": 1, "text": "..."} либо {"id": 1, "error": "..."}.

Важно: stdout/stderr принудительно переводятся в UTF-8, а JSON пишется в ASCII
(ensure_ascii=True). Иначе на Windows консольная кодировка cp1251/cp866 роняет
вывод кириллицы с ошибкой:
  'charmap' codec can't encode characters in position 10-13
"""

import json
import os
import sys

# Строки, которые Whisper часто «придумывает» на тишине/музыке.
HALLUCINATIONS = {
    "you",
    "thank you.",
    "thanks for watching!",
    "thank you for watching!",
    "субтитры сделал dimatorzok",
    "субтитры создавал dimatorzok",
    "продолжение следует...",
    "редактор субтитров а.синецкая корректор а.егорова",
    "！",
    ".",
    "..",
    "...",
}


def configure_stdio() -> None:
    """Делает потоки UTF-8, чтобы кириллица не падала на cp1251/cp866."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def emit(payload: dict) -> None:
    # ensure_ascii=True — гарантированно безопасный вывод в любой кодировке консоли.
    sys.stdout.write(json.dumps(payload, ensure_ascii=True) + "\n")
    sys.stdout.flush()


def log(message: str) -> None:
    sys.stderr.write(f"{message}\n")
    sys.stderr.flush()


def parse_request(line: str):
    line = line.strip()
    if not line:
        return None
    if line.startswith("{"):
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            return None
        path = (data.get("path") or "").strip()
        if not path:
            return None
        return data.get("id"), path
    return None, line


def clean(text: str) -> str:
    text = " ".join(text.split()).strip()
    if text.lower() in HALLUCINATIONS:
        return ""
    return text


def main() -> None:
    from faster_whisper import WhisperModel

    model_size = os.environ.get("WHISPER_MODEL", "base")
    device = os.environ.get("WHISPER_DEVICE", "cpu")
    compute_type = os.environ.get("WHISPER_COMPUTE_TYPE", "int8")
    language = os.environ.get("WHISPER_LANGUAGE") or None

    log(f"loading whisper model={model_size} device={device} compute={compute_type}")
    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    log("whisper ready")

    for line in sys.stdin:
        request = parse_request(line)
        if request is None:
            continue
        request_id, audio_path = request
        try:
            segments, _info = model.transcribe(
                audio_path,
                language=language,
                beam_size=1,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 350},
                condition_on_previous_text=False,
            )
            parts = []
            for segment in segments:
                if getattr(segment, "no_speech_prob", 0.0) > 0.85:
                    continue
                piece = segment.text.strip()
                if piece:
                    parts.append(piece)
            emit({"id": request_id, "text": clean(" ".join(parts))})
        except Exception as error:  # noqa: BLE001 — любая ошибка уходит клиенту
            emit({"id": request_id, "error": f"{type(error).__name__}: {error}"})


if __name__ == "__main__":
    configure_stdio()
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as error:  # noqa: BLE001
        log(f"fatal: {type(error).__name__}: {error}")
        sys.exit(1)
