package software.amazon.jsii.tests.calculator;

@javax.annotation.Generated(value = "jsii-pacmak")
@software.amazon.jsii.Jsii(module = software.amazon.jsii.tests.calculator.$Module.class, fqn = "jsii-calc.DontComplainAboutVariadicAfterOptional")
public class DontComplainAboutVariadicAfterOptional extends software.amazon.jsii.JsiiObject {
    protected DontComplainAboutVariadicAfterOptional(final software.amazon.jsii.JsiiObject.InitializationMode mode) {
        super(mode);
    }
    public DontComplainAboutVariadicAfterOptional() {
        super(software.amazon.jsii.JsiiObject.InitializationMode.Jsii);
        software.amazon.jsii.JsiiEngine.getInstance().createNewObject(this);
    }

    public java.lang.String optionalAndVariadic(@javax.annotation.Nullable final java.lang.String optional, final java.lang.String... things) {
        return this.jsiiCall("optionalAndVariadic", java.lang.String.class, java.util.stream.Stream.concat(java.util.stream.Stream.of(optional), java.util.Arrays.stream(java.util.Objects.requireNonNull(things, "things is required"))).toArray());
    }
}
