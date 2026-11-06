// Supplies camera frames for detection.
//
// Where the browser supports it (Chrome, Edge), frames are read straight from
// the camera track with MediaStreamTrackProcessor. Unlike a <video> element,
// that keeps delivering frames when the tab is in the background or the window
// is minimized, so detection doesn't stall. Other browsers fall back to the
// <video> element.

export function createFrameSource(video) {
  let reader = null;
  let latest = null; // newest VideoFrame from the track
  let usedTimestamp = null;
  let lastVideoTime = -1;
  let generation = 0;

  async function pump(r, gen) {
    try {
      for (;;) {
        const { value, done } = await r.read();
        if (done || gen !== generation) {
          value?.close();
          break;
        }
        latest?.close();
        latest = value;
      }
    } catch {
      /* track ended or reader cancelled */
    }
  }

  return {
    get mode() {
      return reader ? "track" : "video";
    },

    start(stream) {
      this.stop();
      const track = stream?.getVideoTracks()[0];
      if (track && typeof window.MediaStreamTrackProcessor === "function") {
        try {
          reader = new window.MediaStreamTrackProcessor({ track }).readable.getReader();
          pump(reader, generation);
        } catch (err) {
          console.warn("Reading camera frames directly isn't available; using the video element", err);
          reader = null;
        }
      }
    },

    // The next unseen frame to analyse, or null if there's nothing new yet.
    next() {
      if (reader) {
        if (!latest || latest.timestamp === usedTimestamp) return null;
        usedTimestamp = latest.timestamp;
        return latest;
      }
      if (video.readyState < 2 || video.currentTime === lastVideoTime) return null;
      lastVideoTime = video.currentTime;
      return video;
    },

    stop() {
      generation++;
      reader?.cancel().catch(() => {});
      reader = null;
      latest?.close();
      latest = null;
      usedTimestamp = null;
      lastVideoTime = -1;
    },
  };
}
