#!/bin/bash
# Extracts frames from a video so they can be looked at.
#
#   scripts/frames.sh <video> [time ...]     times in seconds; default: every second and the last frame
#
# Options (environment):
#   FRAMES_OUT=<dir>    where to write (default: a new temporary folder)
#   FRAMES_WIDTH=<px>   frame width (default 540; 0 keeps the video's size)
#
# Writes <seconds>.png per frame, labelled with the time asked for and the frame's own time, and
# sheet.png (all of them side by side), and prints the folder. Uses the ffmpeg doomship doctor finds.
set -u
VIDEO=${1:?usage: scripts/frames.sh <video> [time ...]}
shift
[ -f "$VIDEO" ] || { echo "No such video: $VIDEO" >&2; exit 1; }

FFMPEG=${DOOMSHIP_FFMPEG:-}
for f in /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg /usr/local/opt/ffmpeg-full/bin/ffmpeg ffmpeg; do
    [ -n "$FFMPEG" ] && break
    command -v "$f" >/dev/null && FFMPEG=$f
done
FFPROBE=$(dirname "$FFMPEG")/ffprobe
[ -x "$FFPROBE" ] || FFPROBE=ffprobe

OUT=${FRAMES_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/frames.XXXXXX")}
WIDTH=${FRAMES_WIDTH:-540}
mkdir -p "$OUT"
rm -f "$OUT"/*.png

DURATION=$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$VIDEO")
if [ $# -eq 0 ]; then
    set -- $(awk -v d="$DURATION" 'BEGIN { for (t = 0; t < d; t += 1) printf "%g ", t }')
fi

FONT="$(cd "$(dirname "$0")/.." && pwd)/resources/fonts/Inter-ExtraBold.ttf"
size="scale=iw:ih"
[ "$WIDTH" != 0 ] && size="scale=$WIDTH:-2"
# Each frame is labelled with the time asked for and the time of the frame actually shown.
label="drawtext=fontfile='$FONT':x=8:y=8:fontsize=h/40:fontcolor=yellow:box=1:boxcolor=black@0.7"
for t in "$@"; do
    name=$(printf "%06.2f" "$t")
    # What is on screen at t is the last frame at or before t: simulator recordings only have a
    # frame when the screen changes, so a plain seek would show the next change instead.
    from=$(awk -v t="$t" 'BEGIN { print (t > 5 ? t - 5 : 0) }')
    # (-v fatal: -update with copied timestamps warns once per frame it overwrites.)
    "$FFMPEG" -v fatal -ss "$from" -copyts -fflags +igndts -i "$VIDEO" -to "$t" -update 1 \
        -vf "select='lte(t\,$t)',$size,$label:text='$name s (frame %{pts\:flt})'" -fps_mode passthrough \
        -y "$OUT/$name.png"
    [ -f "$OUT/$name.png" ] || echo "No frame at $t s" >&2
done
# The last frame: seek near the end and keep overwriting until the stream runs out.
"$FFMPEG" -v error -sseof -0.5 -fflags +igndts -i "$VIDEO" -update 1 -vf "$size,$label:text='last'" -y "$OUT/last.png"

# A contact sheet, five frames to a row, in time order.
count=$(ls "$OUT"/*.png | wc -l | tr -d ' ')
cols=$(( count < 5 ? count : 5 ))
rows=$(( (count + cols - 1) / cols ))
"$FFMPEG" -v error -pattern_type glob -i "$OUT/*.png" -vf "scale=270:-2,tile=${cols}x${rows}:padding=4" \
    -frames:v 1 -y "$OUT/sheet.png"

echo "duration $DURATION s"
echo "$OUT"
