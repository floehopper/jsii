import inspect

from typing import Any, List, Optional, Type

import collections.abc
import functools

import attr

from jsii import _reference_map
from jsii._utils import Singleton
from jsii._kernel.providers import BaseKernel, ProcessKernel
from jsii._kernel.types import JSClass, Referenceable
from jsii._kernel.types import (
    LoadRequest,
    CreateRequest,
    DeleteRequest,
    GetRequest,
    InvokeRequest,
    SetRequest,
    StaticGetRequest,
    StaticInvokeRequest,
    StaticSetRequest,
    StatsRequest,
    ObjRef,
    Override,
)


_nothing = object()


def _get_overides(klass: JSClass, obj: Any) -> List[Override]:
    overrides = []

    # We need to inspect each item in the MRO, until we get to our JSClass, at that
    # point we'll bail, because those methods are not the overriden methods, but the
    # "real" methods.
    for mro_klass in type(obj).mro():
        if mro_klass is klass:
            break

        for name, item in mro_klass.__dict__.items():
            # We're only interested in things that also exist on the JSII class, and
            # which are themselves, jsii members.
            original = getattr(klass, name, _nothing)
            if original is not _nothing:
                if inspect.isfunction(item) and hasattr(original, "__jsii_name__"):
                    overrides.append(
                        Override(method=original.__jsii_name__, cookie=name)
                    )
                elif inspect.isdatadescriptor(item) and hasattr(
                    original.fget, "__jsii_name__"
                ):
                    overrides.append(
                        Override(property_=original.fget.__jsii_name__, cookie=name)
                    )

    return overrides


def _recursize_dereference(kernel, d):
    if isinstance(d, collections.abc.Mapping):
        return {k: _recursize_dereference(kernel, v) for k, v in d.items()}
    elif isinstance(d, ObjRef):
        return _reference_map.resolve_reference(kernel, d)
    else:
        return d


def _dereferenced(fn):
    @functools.wraps(fn)
    def wrapped(kernel, *args, **kwargs):
        return _recursize_dereference(kernel, fn(kernel, *args, **kwargs))

    return wrapped


@attr.s(auto_attribs=True, frozen=True, slots=True)
class Statistics:

    object_count: int


class Kernel(metaclass=Singleton):

    # This class translates between the Pythonic interface for the kernel, and the
    # Kernel Provider interface that maps more directly to the JSII Kernel interface.
    # It currently only supports the idea of a process kernel provider, however it
    # should be possible to move to other providers in the future.

    # TODO: We don't currently have any error handling, but we need to. This should
    #       probably live at the provider layer though, maybe with something catching
    #       them at this layer to translate it to something more Pythonic, depending
    #       on what the provider layer looks like.

    def __init__(self, provider_class: Type[BaseKernel] = ProcessKernel) -> None:
        self.provider = provider_class()

    # TODO: Do we want to return anything from this method? Is the return value useful
    #       to anyone?
    def load(self, name: str, version: str, tarball: str) -> None:
        self.provider.load(LoadRequest(name=name, version=version, tarball=tarball))

    # TODO: Is there a way to say that obj has to be an instance of klass?
    def create(
        self, klass: JSClass, obj: Any, args: Optional[List[Any]] = None
    ) -> ObjRef:
        if args is None:
            args = []

        overrides = _get_overides(klass, obj)

        obj.__jsii_ref__ = self.provider.create(
            CreateRequest(fqn=klass.__jsii_type__, args=args, overrides=overrides)
        )

        return obj.__jsii_ref__

    def delete(self, ref: ObjRef) -> None:
        self.provider.delete(DeleteRequest(objref=ref))

    @_dereferenced
    def get(self, obj: Referenceable, property: str) -> Any:
        return self.provider.get(
            GetRequest(objref=obj.__jsii_ref__, property_=property)
        ).value

    def set(self, obj: Referenceable, property: str, value: Any) -> None:
        self.provider.set(
            SetRequest(objref=obj.__jsii_ref__, property_=property, value=value)
        )

    @_dereferenced
    def sget(self, klass: JSClass, property: str) -> Any:
        return self.provider.sget(
            StaticGetRequest(fqn=klass.__jsii_type__, property_=property)
        ).value

    def sset(self, klass: JSClass, property: str, value: Any) -> None:
        self.provider.sset(
            StaticSetRequest(fqn=klass.__jsii_type__, property_=property, value=value)
        )

    @_dereferenced
    def invoke(
        self, obj: Referenceable, method: str, args: Optional[List[Any]] = None
    ) -> Any:
        if args is None:
            args = []

        return self.provider.invoke(
            InvokeRequest(objref=obj.__jsii_ref__, method=method, args=args)
        ).result

    @_dereferenced
    def sinvoke(
        self, klass: JSClass, method: str, args: Optional[List[Any]] = None
    ) -> Any:
        if args is None:
            args = []

        return self.provider.sinvoke(
            StaticInvokeRequest(fqn=klass.__jsii_type__, method=method, args=args)
        ).result

    def stats(self):
        resp = self.provider.stats(StatsRequest())

        return Statistics(object_count=resp.objectCount)