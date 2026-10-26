#!/bin/sh
# frames.json (from capture.mjs, same directory) -> raw.mp4 -> promo.mp4 (1080p)
# and promo-720p.mp4 (the one in docs/); the scale section plays at 2x
set -e
node -e '
const {frames,marks}=require("./frames.json");
const t0=frames[0].t; let s="";
for(let i=0;i<frames.length;i++){const d=Math.max(0.001,i+1<frames.length?frames[i+1].t-frames[i].t:0.1); s+=`file frames/${frames[i].name}\nduration ${d.toFixed(4)}\n`;}
s+=`file frames/${frames.at(-1).name}\n`;
require("fs").writeFileSync("list.txt",s);
const m=Object.fromEntries(marks.map(x=>[x.label,(x.t-t0).toFixed(2)]));
require("fs").writeFileSync("cuts.env",`A=${m.scale}\nB=${m.ocean}\n`);
console.log(m);'
. ./cuts.env
ffmpeg -y -loglevel error -f concat -safe 0 -i list.txt -vf "fps=30,format=yuv420p" -c:v libx264 -crf 18 -preset slow raw.mp4
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 raw.mp4)
ffmpeg -y -loglevel error -i raw.mp4 -filter_complex "
[0:v]trim=0:$A,setpts=PTS-STARTPTS[a];
[0:v]trim=$A:$B,setpts=(PTS-STARTPTS)/2[b];
[0:v]trim=$B:$D,setpts=PTS-STARTPTS[c];
[a][b][c]concat=n=3:v=1,fps=30,fade=t=in:st=0:d=0.6,format=yuv420p,split[v1][t];
[t]scale=1280:-2[v2]" -map "[v1]" -c:v libx264 -crf 23 -preset slow -movflags +faststart promo.mp4 -map "[v2]" -c:v libx264 -crf 25 -preset slow -movflags +faststart promo-720p.mp4
for f in promo.mp4 promo-720p.mp4; do echo $f $(du -h $f | cut -f1) $(ffprobe -v error -show_entries format=duration -of csv=p=0 $f); done
