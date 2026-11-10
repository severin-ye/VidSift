VidSift native media workflow references BiliNote by Jeffery Huang:
https://github.com/JefferyHcool/BiliNote/tree/90940fde4d224d0f69ad99674f4af0a1ea52d3c4

Adapted concepts: subtitle-first metadata-only resolution (backend/app/downloaders/youtube_subtitle.py), chronological FFmpeg frames with Pillow timestamp grids (backend/app/utils/video_reader.py), original Douyin video object/download address (backend/app/downloaders/douyin_downloader.py, download_video). This implementation deliberately uses the original video's audio, not BiliNote's music.play_url audio branch; it handles modern transcript snippet objects and retains partial grids.

MIT License

Copyright (c) 2024 Jeffery Huang

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
