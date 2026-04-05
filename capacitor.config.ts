import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.rahimovanton.talkbridge",
  appName: "Talk Bridge",
  webDir: "public",
  server: {
    // Load UI from the deployed server — all relative API calls work as-is
    url: "https://talk-bridge-mvp.onrender.com",
    cleartext: false,
  },
};

export default config;
