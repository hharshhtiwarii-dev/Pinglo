package com.devbhai.pinglo;

import androidx.appcompat.app.AppCompatActivity;
import androidx.biometric.BiometricManager;
import androidx.biometric.BiometricPrompt;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Fingerprint / face unlock using androidx.biometric. Strong biometrics only.
 * authenticate() always resolves: { ok: true } or { ok: false, error } so the
 * web side can fall back to the PIN without treating a cancel as a crash.
 */
@CapacitorPlugin(name = "Biometric")
public class BiometricPlugin extends Plugin {

    private static final int AUTHENTICATORS = BiometricManager.Authenticators.BIOMETRIC_STRONG;

    @PluginMethod
    public void isAvailable(PluginCall call) {
        int result = BiometricManager.from(getContext()).canAuthenticate(AUTHENTICATORS);
        JSObject ret = new JSObject();
        ret.put("available", result == BiometricManager.BIOMETRIC_SUCCESS);
        call.resolve(ret);
    }

    @PluginMethod
    public void authenticate(PluginCall call) {
        final AppCompatActivity activity = getActivity();
        if (activity == null) {
            call.reject("No activity to show the prompt");
            return;
        }
        final String title = call.getString("title", "Unlock");
        final String subtitle = call.getString("subtitle", "");

        activity.runOnUiThread(() -> {
            BiometricPrompt prompt = new BiometricPrompt(
                activity,
                ContextCompat.getMainExecutor(getContext()),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override
                    public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        JSObject ret = new JSObject();
                        ret.put("ok", true);
                        call.resolve(ret);
                    }

                    @Override
                    public void onAuthenticationError(int errorCode, CharSequence errString) {
                        JSObject ret = new JSObject();
                        ret.put("ok", false);
                        ret.put("error", String.valueOf(errString));
                        call.resolve(ret);
                    }
                });

            BiometricPrompt.PromptInfo info = new BiometricPrompt.PromptInfo.Builder()
                .setTitle(title)
                .setSubtitle(subtitle)
                .setNegativeButtonText("Use PIN")
                .setAllowedAuthenticators(AUTHENTICATORS)
                .build();
            prompt.authenticate(info);
        });
    }
}
