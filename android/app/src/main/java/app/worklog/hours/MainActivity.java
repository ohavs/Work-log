package app.worklog.hours;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Plugins that live in this module rather than in an npm package
        // aren't discovered automatically, and registration has to happen
        // before the bridge is built — hence before super.onCreate().
        registerPlugin(ApkInstallerPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
