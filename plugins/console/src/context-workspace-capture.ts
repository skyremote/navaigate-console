/** Browser/desktop display picker. Never silently captures another machine or guesses OS APIs. */
export async function captureDisplayFrame(): Promise<{
  bytes: Uint8Array;
  label: string;
  mimeType: string;
}> {
  if (!navigator.mediaDevices?.getDisplayMedia)
    throw new Error(
      "Window capture is unavailable on this device. Attach a screenshot using BB’s file control.",
    );
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "window" },
    audio: false,
  });
  try {
    const video = document.createElement("video");
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    if (!video.videoWidth || !video.videoHeight)
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          clean();
          reject(new Error("The selected window did not produce an image."));
        }, 5000);
        const clean = () => {
          clearTimeout(timeout);
          video.removeEventListener("loadeddata", ready);
        };
        const ready = () => {
          clean();
          resolve();
        };
        video.addEventListener("loadeddata", ready, { once: true });
      });
    if (!video.videoWidth || !video.videoHeight)
      throw new Error("The selected window has no image pixels.");
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image capture is unavailable.");
    ctx.drawImage(video, 0, 0);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) =>
          b
            ? resolve(b)
            : reject(new Error("Could not encode the screenshot.")),
        "image/png",
      ),
    );
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      label: stream.getVideoTracks()[0]?.label ?? "Selected window",
      mimeType: "image/png",
    };
  } finally {
    for (const track of stream.getTracks()) track.stop();
  }
}
