package com.envpit.example.dropwizard;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.Produces;
import jakarta.ws.rs.core.MediaType;

import java.util.Map;
import java.util.Set;

/**
 * The "single endpoint" the task brief allows in place of relying on a startup log alone. Returns
 * key NAMES only — reads straight off the same {@link EnvpitExampleConfiguration#getEnvpitConfig()}
 * map the health check verifies, never the SDK client directly, to prove the framework's own
 * configuration object is what's actually serving requests.
 */
@Path("/config-keys")
@Produces(MediaType.APPLICATION_JSON)
public class ConfigKeysResource {

    private final Map<String, String> envpitConfig;

    public ConfigKeysResource(Map<String, String> envpitConfig) {
        this.envpitConfig = envpitConfig;
    }

    @GET
    public Set<String> configKeys() {
        return envpitConfig.keySet();
    }
}
