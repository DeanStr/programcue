import { Config } from "@remotion/cli/config";

Config.setEntryPoint("video/index.ts");
Config.setPublicDir("video/public");
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(96);
Config.setConcurrency(4);
Config.setDelayRenderTimeoutInMilliseconds(60_000);
Config.setChromiumOpenGlRenderer("angle");
Config.setOverwriteOutput(true);
