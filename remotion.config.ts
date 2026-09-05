import { Config } from "@remotion/cli/config";

Config.setEntryPoint("video/index.ts");
Config.setPublicDir("video/public");
Config.setVideoImageFormat("png");
Config.setConcurrency(4);
Config.setDelayRenderTimeoutInMilliseconds(60_000);
Config.setChromiumOpenGlRenderer("angle");
Config.setOverwriteOutput(true);
