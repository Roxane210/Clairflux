export interface CapacitorServerConfig {
  readonly androidScheme: 'https' | 'http';
  readonly hostname?: string;
  readonly url?: string;
  readonly cleartext?: boolean;
}

export interface CapacitorAndroidConfig {
  readonly allowMixedContent: boolean;
  readonly captureInput: boolean;
  readonly webContentsDebuggingEnabled?: boolean;
}

export interface CapacitorPluginsConfig {
  readonly CapacitorHttp?: {
    readonly enabled: boolean;
  };
}

export interface CapacitorConfig {
  readonly appId: string;
  readonly appName: string;
  readonly webDir: string;
  readonly server?: CapacitorServerConfig;
  readonly android?: CapacitorAndroidConfig;
  readonly plugins?: CapacitorPluginsConfig;
}

const config: CapacitorConfig = {
  appId: 'com.clairflux.finance',
  appName: 'ClairFlux',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
  },
};

export default config;
