# This module exists to break an import cycle between jsii.runtime and jsii.kernel
import inspect
import weakref

from typing import Any, MutableMapping

from ._kernel.types import JSClass, Referenceable


_types = {}
_data_types: MutableMapping[str, Any] = {}


def register_type(klass: JSClass):
    _types[klass.__jsii_type__] = klass


def register_data_type(data_type: Any):
    _data_types[data_type.__jsii_type__] = data_type


class _FakeReference:
    def __init__(self, ref: str) -> None:
        self.__jsii_ref__ = ref


class _ReferenceMap:
    def __init__(self, types):
        self._refs = weakref.WeakValueDictionary()
        self._types = types

    def register(self, inst: Referenceable):
        self._refs[inst.__jsii_ref__.ref] = inst

    def resolve(self, kernel, ref):
        # First we need to check our reference map to see if we have any instance that
        # already matches this reference.
        try:
            return self._refs[ref.ref]
        except KeyError:
            pass

        # If we got to this point, then we didn't have a referene for this, in that case
        # we want to create a new instance, but we need to create it in such a way that
        # we don't try to recreate the type inside of the JSII interface.
        class_fqn = ref.ref.rsplit("@", 1)[0]
        if class_fqn in _types:
            klass = _types[class_fqn]

            # If this class is an abstract class, then we'll use the generated proxy
            # class instead of the abstract class to handle return values for this type.
            if inspect.isabstract(klass):
                klass = klass.__jsii_proxy_class__()

            # Create our instance, bypassing __init__ by directly calling __new__, and
            # then assign our reference to __jsii_ref__
            inst = klass.__new__(klass)
            inst.__jsii_ref__ = ref
        elif class_fqn in _data_types:
            data_type = _data_types[class_fqn]

            # A Data type is nothing more than a dictionary, however we need to iterate
            # over all of it's properties, and ask the kernel for the values of each of
            # then in order to constitute our dict
            inst = {}

            for name in data_type.__annotations__.keys():
                # This is a hack, because our kernel expects an object that has a
                # __jsii_ref__ attached to it, and we don't have one of those.
                inst[name] = kernel.get(_FakeReference(ref), name)
        else:
            raise ValueError(f"Unknown type: {class_fqn}")

        return inst


_refs = _ReferenceMap(_types)


register_reference = _refs.register
resolve_reference = _refs.resolve